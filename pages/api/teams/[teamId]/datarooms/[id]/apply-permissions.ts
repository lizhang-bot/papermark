import { NextApiRequest, NextApiResponse } from "next";

import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { DefaultPermissionStrategy, ItemType } from "@prisma/client";
import { getServerSession } from "next-auth";

import { errorhandler } from "@/lib/errorHandler";
import prisma from "@/lib/prisma";
import { CustomUser } from "@/lib/types";

type GroupTarget = "VIEWER_GROUP" | "PERMISSION_GROUP";

const VALID_STRATEGIES = new Set<string>([
  "INHERIT_FROM_PARENT",
  "ASK_EVERY_TIME",
  "HIDDEN_BY_DEFAULT",
]);

async function revalidateLinksForDataroom(dataroomId: string): Promise<void> {
  try {
    const links = await prisma.link.findMany({
      where: {
        dataroomId,
        deletedAt: null,
        OR: [
          { permissionGroupId: { not: null } },
          { groupId: { not: null } },
        ],
      },
      select: { id: true, domainId: true },
    });

    if (links.length === 0) return;

    const revalidateUrl = process.env.NEXTAUTH_URL;
    const revalidateToken = process.env.REVALIDATE_TOKEN;
    if (!revalidateUrl || !revalidateToken) return;

    await Promise.all(
      links.map((link) =>
        fetch(
          `${revalidateUrl}/api/revalidate?secret=${revalidateToken}&linkId=${link.id}&hasDomain=${link.domainId ? "true" : "false"}`,
        ).catch((err) =>
          console.error(`Error revalidating link ${link.id}:`, err),
        ),
      ),
    );
  } catch (error) {
    console.error(
      `Error revalidating links for dataroom ${dataroomId}:`,
      error,
    );
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const { teamId, id: dataroomId } = req.query as {
    teamId: string;
    id: string;
  };

  const userId = (session.user as CustomUser).id;

  try {
    const {
      documentIds,
      strategy,
      groupStrategy,
      linkStrategy,
      folderPath,
    } = req.body as {
      documentIds: string[];
      strategy?: string;
      groupStrategy?: string;
      linkStrategy?: string;
      folderPath?: string;
    };

    // Validate input
    if (
      !documentIds ||
      !Array.isArray(documentIds) ||
      documentIds.length === 0
    ) {
      return res.status(400).json({ message: "Document IDs are required" });
    }

    // Validate all provided strategies
    for (const value of [strategy, groupStrategy, linkStrategy]) {
      if (value !== undefined && !VALID_STRATEGIES.has(value)) {
        return res.status(400).json({ message: "Invalid strategy" });
      }
    }

    // Check if the user is part of the team
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        users: { some: { userId } },
      },
    });

    if (!team) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Get dataroom and verify it exists and belongs to the team
    const dataroom = await prisma.dataroom.findUnique({
      where: { id: dataroomId },
      select: {
        id: true,
        teamId: true,
        defaultPermissionStrategy: true,
        defaultGroupPermissionStrategy: true,
      },
    });

    if (!dataroom || dataroom.teamId !== teamId) {
      return res.status(404).json({ message: "Dataroom not found" });
    }

    // Resolve effective strategies. Precedence:
    //   1. Explicit per-target strategy from the request body.
    //   2. Legacy `strategy` field (applied to both targets) for backward
    //      compatibility with older clients that didn't know about the split.
    //   3. The dataroom's stored defaults.
    const effectiveGroupStrategy =
      (groupStrategy as DefaultPermissionStrategy | undefined) ??
      (strategy as DefaultPermissionStrategy | undefined) ??
      dataroom.defaultGroupPermissionStrategy;
    const effectiveLinkStrategy =
      (linkStrategy as DefaultPermissionStrategy | undefined) ??
      (strategy as DefaultPermissionStrategy | undefined) ??
      dataroom.defaultPermissionStrategy;

    // Get dataroom documents for the provided document IDs
    const dataroomDocuments = await prisma.dataroomDocument.findMany({
      where: {
        documentId: { in: documentIds },
        dataroomId,
      },
      select: { id: true, documentId: true, folderId: true },
    });

    if (dataroomDocuments.length === 0) {
      return res
        .status(404)
        .json({ message: "No documents found in this dataroom" });
    }

    // Apply each strategy independently to its target group type
    await Promise.all([
      applyPermissionStrategy({
        dataroomId,
        dataroomDocuments,
        strategy: effectiveGroupStrategy,
        folderPath,
        target: "VIEWER_GROUP",
      }),
      applyPermissionStrategy({
        dataroomId,
        dataroomDocuments,
        strategy: effectiveLinkStrategy,
        folderPath,
        target: "PERMISSION_GROUP",
      }),
    ]);

    // Revalidate ISR pages for links with permission restrictions
    await revalidateLinksForDataroom(dataroomId);

    return res.status(200).json({
      message: "Permissions applied successfully",
      documentsProcessed: dataroomDocuments.length,
      groupStrategy: effectiveGroupStrategy,
      linkStrategy: effectiveLinkStrategy,
    });
  } catch (error) {
    errorhandler(error, res);
  }
}

async function applyPermissionStrategy(opts: {
  dataroomId: string;
  dataroomDocuments: {
    id: string;
    documentId: string;
    folderId: string | null;
  }[];
  strategy: DefaultPermissionStrategy;
  folderPath?: string;
  target: GroupTarget;
}) {
  const { dataroomId, dataroomDocuments, strategy, folderPath, target } = opts;

  // ASK_EVERY_TIME and HIDDEN_BY_DEFAULT both intentionally leave the document
  // hidden until something else writes the access control rows (the unified
  // permissions modal for ASK_EVERY_TIME, manual configuration for
  // HIDDEN_BY_DEFAULT).
  if (strategy !== DefaultPermissionStrategy.INHERIT_FROM_PARENT) return;

  const isRootLevel = !folderPath || folderPath.length === 0;

  if (isRootLevel) {
    await applyRootLevelPermissions(dataroomId, dataroomDocuments, target);
  } else {
    await inheritFromParentFolder(
      dataroomId,
      dataroomDocuments,
      folderPath!,
      target,
    );
  }
}

async function applyRootLevelPermissions(
  dataroomId: string,
  dataroomDocuments: {
    id: string;
    documentId: string;
    folderId: string | null;
  }[],
  target: GroupTarget,
) {
  if (target === "VIEWER_GROUP") {
    const viewerGroups = await prisma.viewerGroup.findMany({
      where: { dataroomId },
      select: { id: true },
    });
    if (viewerGroups.length === 0) return;

    const data = viewerGroups.flatMap((group) =>
      dataroomDocuments.map((doc) => ({
        groupId: group.id,
        itemId: doc.id,
        itemType: ItemType.DATAROOM_DOCUMENT,
        canView: true,
        canDownload: false,
      })),
    );

    if (data.length > 0) {
      await prisma.viewerGroupAccessControls.createMany({
        data,
        skipDuplicates: true,
      });
    }
    return;
  }

  const permissionGroups = await prisma.permissionGroup.findMany({
    where: { dataroomId },
    select: { id: true },
  });
  if (permissionGroups.length === 0) return;

  const data = permissionGroups.flatMap((group) =>
    dataroomDocuments.map((doc) => ({
      groupId: group.id,
      itemId: doc.id,
      itemType: ItemType.DATAROOM_DOCUMENT,
      canView: true,
      canDownload: false,
      canDownloadOriginal: false,
    })),
  );

  if (data.length > 0) {
    await prisma.permissionGroupAccessControls.createMany({
      data,
      skipDuplicates: true,
    });
  }
}

async function inheritFromParentFolder(
  dataroomId: string,
  dataroomDocuments: {
    id: string;
    documentId: string;
    folderId: string | null;
  }[],
  folderPath: string,
  target: GroupTarget,
) {
  const pathSegments = folderPath.split("/").filter(Boolean);
  const parentPath = "/" + pathSegments.slice(0, -1).join("/");

  const parentFolder = await prisma.dataroomFolder.findUnique({
    where: {
      dataroomId_path: { dataroomId, path: parentPath },
    },
    select: { id: true },
  });

  if (!parentFolder) {
    await applyRootLevelPermissions(dataroomId, dataroomDocuments, target);
    return;
  }

  if (target === "VIEWER_GROUP") {
    const parentViewerPermissions =
      await prisma.viewerGroupAccessControls.findMany({
        where: {
          itemId: parentFolder.id,
          itemType: ItemType.DATAROOM_FOLDER,
        },
        select: { groupId: true, canView: true, canDownload: true },
      });

    if (parentViewerPermissions.length === 0) return;

    const data = parentViewerPermissions.flatMap((parentPerm) =>
      dataroomDocuments.map((doc) => ({
        groupId: parentPerm.groupId,
        itemId: doc.id,
        itemType: ItemType.DATAROOM_DOCUMENT,
        canView: parentPerm.canView,
        canDownload: parentPerm.canDownload,
      })),
    );

    if (data.length > 0) {
      await prisma.viewerGroupAccessControls.createMany({
        data,
        skipDuplicates: true,
      });
    }
    return;
  }

  const parentPermissionGroupPermissions =
    await prisma.permissionGroupAccessControls.findMany({
      where: {
        itemId: parentFolder.id,
        itemType: ItemType.DATAROOM_FOLDER,
      },
      select: {
        groupId: true,
        canView: true,
        canDownload: true,
        canDownloadOriginal: true,
      },
    });

  if (parentPermissionGroupPermissions.length === 0) return;

  const data = parentPermissionGroupPermissions.flatMap((parentPerm) =>
    dataroomDocuments.map((doc) => ({
      groupId: parentPerm.groupId,
      itemId: doc.id,
      itemType: ItemType.DATAROOM_DOCUMENT,
      canView: parentPerm.canView,
      canDownload: parentPerm.canDownload,
      canDownloadOriginal: parentPerm.canDownloadOriginal,
    })),
  );

  if (data.length > 0) {
    await prisma.permissionGroupAccessControls.createMany({
      data,
      skipDuplicates: true,
    });
  }
}
