import { NextApiRequest, NextApiResponse } from "next";

import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { DefaultPermissionStrategy, ItemType } from "@prisma/client";
import { safeSlugify } from "@/lib/utils";
import { getServerSession } from "next-auth/next";

import prisma from "@/lib/prisma";
import { CustomUser } from "@/lib/types";

async function applyFolderPermissions(
  dataroomId: string,
  folderId: string,
  folderPath: string,
): Promise<void> {
  try {
    await applyDefaultFolderPermissions(dataroomId, folderId, folderPath);
  } catch (error) {
    console.error("Error applying folder permissions:", error);
    throw error;
  }
}

async function applyDefaultFolderPermissions(
  dataroomId: string,
  folderId: string,
  folderPath?: string,
) {
  const [dataroom, viewerGroups, permissionGroups] = await Promise.all([
    prisma.dataroom.findUnique({
      where: { id: dataroomId },
      select: {
        defaultPermissionStrategy: true,
        defaultGroupPermissionStrategy: true,
        teamId: true,
      },
    }),
    prisma.viewerGroup.findMany({
      where: { dataroomId },
      select: {
        id: true,
      },
    }),
    prisma.permissionGroup.findMany({
      where: { dataroomId },
      select: {
        id: true,
        name: true,
      },
    }),
  ]);

  if (!dataroom) return;

  // Resolve parent folder once if any side wants to inherit. We can't bail
  // out early for both sides anymore because the group strategy and the
  // link strategy can disagree.
  const groupInherits =
    dataroom.defaultGroupPermissionStrategy ===
    DefaultPermissionStrategy.INHERIT_FROM_PARENT;
  const linkInherits =
    dataroom.defaultPermissionStrategy ===
    DefaultPermissionStrategy.INHERIT_FROM_PARENT;

  let parentFolderId: string | null = null;
  if ((groupInherits || linkInherits) && folderPath) {
    const pathSegments = folderPath.split("/").filter(Boolean);
    const parentPath = "/" + pathSegments.slice(0, -1).join("/");
    if (parentPath !== "/") {
      const parent = await prisma.dataroomFolder.findUnique({
        where: { dataroomId_path: { dataroomId, path: parentPath } },
        select: { id: true },
      });
      parentFolderId = parent?.id ?? null;
    }
  }

  await Promise.all([
    applyForViewerGroups({
      dataroomId,
      folderId,
      viewerGroups,
      strategy: dataroom.defaultGroupPermissionStrategy,
      parentFolderId,
    }),
    applyForPermissionGroups({
      dataroomId,
      folderId,
      permissionGroups,
      strategy: dataroom.defaultPermissionStrategy,
      parentFolderId,
    }),
  ]);
}

async function applyForViewerGroups(opts: {
  dataroomId: string;
  folderId: string;
  viewerGroups: { id: string }[];
  strategy: DefaultPermissionStrategy;
  parentFolderId: string | null;
}) {
  const { folderId, viewerGroups, strategy, parentFolderId } = opts;

  if (strategy !== DefaultPermissionStrategy.INHERIT_FROM_PARENT) return;
  if (viewerGroups.length === 0) return;

  if (parentFolderId) {
    const parentPerms = await prisma.viewerGroupAccessControls.findMany({
      where: {
        itemId: parentFolderId,
        itemType: ItemType.DATAROOM_FOLDER,
      },
      select: { groupId: true, canView: true, canDownload: true },
    });

    if (parentPerms.length === 0) return;

    await prisma.viewerGroupAccessControls.createMany({
      data: parentPerms.map((p) => ({
        groupId: p.groupId,
        itemId: folderId,
        itemType: ItemType.DATAROOM_FOLDER,
        canView: p.canView,
        canDownload: p.canDownload,
      })),
      skipDuplicates: true,
    });
    return;
  }

  await prisma.viewerGroupAccessControls.createMany({
    data: viewerGroups.map((group) => ({
      groupId: group.id,
      itemId: folderId,
      itemType: ItemType.DATAROOM_FOLDER,
      canView: true,
      canDownload: false,
    })),
    skipDuplicates: true,
  });
}

async function applyForPermissionGroups(opts: {
  dataroomId: string;
  folderId: string;
  permissionGroups: { id: string }[];
  strategy: DefaultPermissionStrategy;
  parentFolderId: string | null;
}) {
  const { folderId, permissionGroups, strategy, parentFolderId } = opts;

  if (strategy !== DefaultPermissionStrategy.INHERIT_FROM_PARENT) return;
  if (permissionGroups.length === 0) return;

  if (parentFolderId) {
    const parentPerms = await prisma.permissionGroupAccessControls.findMany({
      where: {
        itemId: parentFolderId,
        itemType: ItemType.DATAROOM_FOLDER,
      },
      select: {
        groupId: true,
        canView: true,
        canDownload: true,
        canDownloadOriginal: true,
      },
    });

    if (parentPerms.length === 0) return;

    await prisma.permissionGroupAccessControls.createMany({
      data: parentPerms.map((p) => ({
        groupId: p.groupId,
        itemId: folderId,
        itemType: ItemType.DATAROOM_FOLDER,
        canView: p.canView,
        canDownload: p.canDownload,
        canDownloadOriginal: p.canDownloadOriginal,
      })),
      skipDuplicates: true,
    });
    return;
  }

  await prisma.permissionGroupAccessControls.createMany({
    data: permissionGroups.map((group) => ({
      groupId: group.id,
      itemId: folderId,
      itemType: ItemType.DATAROOM_FOLDER,
      canView: true,
      canDownload: false,
      canDownloadOriginal: false,
    })),
    skipDuplicates: true,
  });
}

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") {
    // GET /api/teams/:teamId/datarooms/:id/folders
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      return res.status(401).end("Unauthorized");
    }

    const userId = (session.user as CustomUser).id;
    const {
      teamId,
      id: dataroomId,
      root,
      include_documents,
    } = req.query as {
      teamId: string;
      id: string;
      root?: string;
      include_documents?: string;
    };

    try {
      // Check if the user is part of the team
      const team = await prisma.team.findUnique({
        where: {
          id: teamId,
          users: {
            some: {
              userId: userId,
            },
          },
        },
      });

      if (!team) {
        return res.status(401).end("Unauthorized");
      }

      /** if root is present then only get root folders */
      if (root === "true") {
        const folders = await prisma.dataroomFolder.findMany({
          where: {
            dataroomId,
            parentId: null,
          },
          orderBy: [{ orderIndex: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            path: true,
            parentId: true,
            dataroomId: true,
            orderIndex: true,
            hierarchicalIndex: true,
            icon: true,
            color: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: { documents: true, childFolders: true },
            },
          },
        });

        return res.status(200).json(folders);
      }

      if (include_documents === "true") {
        const dataroomFolders = await prisma.dataroom.findUnique({
          where: {
            id: dataroomId,
          },
          select: {
            documents: {
              where: { folderId: null },
              orderBy: [{ orderIndex: "asc" }, { document: { name: "asc" } }],
              select: {
                id: true,
                folderId: true,
                hierarchicalIndex: true,
                document: {
                  select: {
                    id: true,
                    name: true,
                    type: true,
                  },
                },
              },
            },
            folders: {
              select: {
                id: true,
                name: true,
                path: true,
                parentId: true,
                dataroomId: true,
                orderIndex: true,
                hierarchicalIndex: true,
                icon: true,
                color: true,
                createdAt: true,
                updatedAt: true,
                documents: {
                  select: {
                    id: true,
                    folderId: true,
                    hierarchicalIndex: true,
                    document: {
                      select: {
                        id: true,
                        name: true,
                        type: true,
                      },
                    },
                  },
                  orderBy: [
                    { orderIndex: "asc" },
                    { document: { name: "asc" } },
                  ],
                },
              },
              orderBy: [{ orderIndex: "asc" }, { name: "asc" }],
            },
          },
        });

        const folders = [
          ...(dataroomFolders?.documents ?? []),
          ...(dataroomFolders?.folders ?? []),
        ];

        return res.status(200).json(folders);
      }

      const folders = await prisma.dataroomFolder.findMany({
        where: {
          dataroomId,
        },
        orderBy: [
          { orderIndex: "asc" },
          {
            name: "asc",
          },
        ],
        select: {
          id: true,
          name: true,
          path: true,
          parentId: true,
          dataroomId: true,
          orderIndex: true,
          hierarchicalIndex: true,
          icon: true,
          color: true,
          createdAt: true,
          updatedAt: true,
          documents: {
            select: {
              orderIndex: true,
              id: true,
              folderId: true,
              hierarchicalIndex: true,
              document: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                },
              },
            },
            orderBy: [
              { orderIndex: "asc" },
              {
                document: {
                  name: "asc",
                },
              },
            ],
          },
          childFolders: {
            include: {
              documents: {
                select: {
                  orderIndex: true,
                  id: true,
                  folderId: true,
                  document: {
                    select: {
                      id: true,
                      name: true,
                      type: true,
                    },
                  },
                },
                orderBy: [
                  { orderIndex: "asc" },
                  {
                    document: {
                      name: "asc",
                    },
                  },
                ],
              },
            },
          },
        },
      });

      return res.status(200).json(folders);
    } catch (error) {
      console.error("Request error", error);
      return res.status(500).json({ error: "Error fetching folders" });
    }
  } else if (req.method === "POST") {
    // POST /api/teams/:teamId/datarooms/:id/folders
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      res.status(401).end("Unauthorized");
      return;
    }

    const userId = (session.user as CustomUser).id;
    const { teamId, id: dataroomId } = req.query as {
      teamId: string;
      id: string;
    };

    const { name, path, icon, color } = req.body as {
      name: string;
      path?: string;
      icon?: string;
      color?: string;
    };

    const parentFolderPath = path ? "/" + path : "/";

    try {
      // Check if the user is part of the team
      const team = await prisma.team.findUnique({
        where: {
          id: teamId,
          users: {
            some: {
              userId: userId,
            },
          },
        },
      });

      if (!team) {
        return res.status(401).end("Unauthorized");
      }

      const parentFolder = await prisma.dataroomFolder.findUnique({
        where: {
          dataroomId_path: {
            dataroomId: dataroomId,
            path: parentFolderPath,
          },
        },
        select: {
          id: true,
          name: true,
          path: true,
        },
      });

      // Duplicate name handling
      let folderName = name;
      let counter = 1;
      const MAX_RETRIES = 50;

      // Split path into segments
      // Slugify the final folder name
      const pathSegments = path ? path.split("/").filter(Boolean) : [];
      const basePath =
        pathSegments.length > 0 ? "/" + pathSegments.join("/") + "/" : "/";

      let childFolderPath = basePath + safeSlugify(folderName);

      while (counter <= MAX_RETRIES) {
        const existingFolder = await prisma.dataroomFolder.findUnique({
          where: {
            dataroomId_path: {
              dataroomId: dataroomId,
              path: childFolderPath,
            },
          },
        });
        if (!existingFolder) break;
        folderName = `${name} (${counter})`;
        childFolderPath = basePath + safeSlugify(folderName);
        counter++;
      }

      if (counter > MAX_RETRIES) {
        return res.status(400).json({
          error: "Failed to create folder",
          message: "Too many folders with similar names",
        });
      }

      const folder = await prisma.dataroomFolder.create({
        data: {
          name: folderName,
          path: childFolderPath,
          parentId: parentFolder?.id ?? null,
          dataroomId: dataroomId,
          icon: icon ?? null,
          color: color ?? null,
        },
      });

      await applyFolderPermissions(dataroomId, folder.id, childFolderPath);

      const folderWithDocs = {
        ...folder,
        documents: [],
        childFolders: [],
        parentFolderPath: parentFolderPath,
      };

      res.status(201).json(folderWithDocs);
    } catch (error) {
      console.error("Request error", error);
      res.status(500).json({ error: "Error creating folder" });
    }
  } else {
    // We only allow GET and POST requests
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
