import { NextApiRequest, NextApiResponse } from "next";

import { getTeamStorageConfigById } from "@/ee/features/storage/config";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getServerSession } from "next-auth";

import { buildBulkDownloadStructure } from "@/lib/dataroom/build-bulk-download-structure";
import prisma from "@/lib/prisma";
import { downloadJobStore } from "@/lib/redis-download-job-store";
import { bulkDownloadTask } from "@/lib/trigger/bulk-download";
import { CustomUser } from "@/lib/types";

export const config = {
  maxDuration: 60, // Reduced since we're just triggering the async task
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).end("Unauthorized");
  }

  const { teamId, id: dataroomId } = req.query as {
    teamId: string;
    id: string;
  };

  const userId = (session.user as CustomUser).id;

  if (req.method === "POST") {
    try {
      const teamAccess = await prisma.userTeam.findUnique({
        where: {
          userId_teamId: {
            userId: userId,
            teamId: teamId,
          },
        },
        select: { teamId: true },
      });

      if (!teamAccess) {
        return res.status(403).end("Unauthorized to access this team");
      }

      const dataroom = await prisma.dataroom.findUnique({
        where: {
          id: dataroomId,
          teamId: teamId,
        },
        select: {
          id: true,
          name: true,
          folders: {
            select: {
              id: true,
              name: true,
              path: true,
              parentId: true,
            },
          },
          documents: {
            select: {
              id: true,
              folderId: true,
              document: {
                select: {
                  name: true,
                  versions: {
                    where: { isPrimary: true },
                    select: {
                      type: true,
                      file: true,
                      storageType: true,
                      originalFile: true,
                      contentType: true,
                      fileSize: true,
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      if (!dataroom) {
        return res.status(404).end("Dataroom not found");
      }

      // Admin bulk download: no permission filtering, no watermark.
      const { folderStructure, fileKeys } = buildBulkDownloadStructure({
        fullFolders: dataroom.folders,
        includedFolders: dataroom.folders,
        includedDocuments: dataroom.documents,
        enableWatermark: false,
      });

      if (fileKeys.length === 0) {
        return res.status(404).json({ error: "No files to download" });
      }

      // Get team-specific storage config
      const storageConfig = await getTeamStorageConfigById(teamId);

      // Get user email for notification
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      // Create download job in Redis
      const job = await downloadJobStore.createJob({
        type: "bulk",
        status: "PENDING",
        dataroomId: dataroom.id,
        dataroomName: dataroom.name,
        totalFiles: fileKeys.length,
        processedFiles: 0,
        progress: 0,
        teamId: teamId,
        userId: userId,
        emailNotification: !!user?.email,
        emailAddress: user?.email ?? undefined,
      });

      // Trigger the async bulk download task
      const handle = await bulkDownloadTask.trigger(
        {
          jobId: job.id,
          dataroomId: dataroom.id,
          dataroomName: dataroom.name,
          teamId: teamId,
          folderStructure: folderStructure,
          fileKeys: fileKeys,
          sourceBucket: storageConfig.bucket,
          watermarkConfig: { enabled: false },
          userId: userId,
          emailNotification: !!user?.email,
          emailAddress: user?.email ?? undefined,
        },
        {
          idempotencyKey: job.id,
          tags: [
            `team_${teamId}`,
            `dataroom_${dataroom.id}`,
            `job_${job.id}`,
            `user_${userId}`,
          ],
        },
      );

      // Update job with trigger run ID
      await downloadJobStore.updateJob(job.id, {
        triggerRunId: handle.id,
      });

      // Return job ID immediately (async response)
      return res.status(202).json({
        jobId: job.id,
        status: "PENDING",
        message: "Download started. You will be notified when ready.",
      });
    } catch (error) {
      console.error("Error starting bulk download:", error);
      return res.status(500).json({
        message: "Internal Server Error",
        error: (error as Error).message,
      });
    }
  } else {
    // We only allow POST requests
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
