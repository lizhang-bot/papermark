import { NextApiRequest, NextApiResponse } from "next";

import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { getServerSession } from "next-auth";

import {
  RestrictedTokenSubjectTypeSchema,
  parseRestrictedTokenSubjectType,
} from "@/lib/api/auth/restricted-tokens";
import { hashToken } from "@/lib/api/auth/token";
import { getFeatureFlags } from "@/lib/featureFlags";
import { newId } from "@/lib/id-helper";
import { GRANULAR_SCOPES, PRESET_SCOPES } from "@/lib/oauth/scopes";
import prisma from "@/lib/prisma";
import { CustomUser } from "@/lib/types";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { teamId } = req.query as { teamId: string };

  const features = await getFeatureFlags({ teamId });
  if (!features.tokens) {
    return res
      .status(403)
      .json({ error: "This feature is not available for your team" });
  }

  if (req.method === "GET") {
    try {
      const session = await getServerSession(req, res, authOptions);
      if (!session) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { teamId } = req.query as { teamId: string };
      const userId = (session.user as CustomUser).id;

      // Check if user is in team
      const userTeam = await prisma.userTeam.findUnique({
        where: {
          userId_teamId: {
            userId,
            teamId,
          },
        },
      });

      if (!userTeam) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // Fetch tokens
      const tokens = await prisma.restrictedToken.findMany({
        where: {
          teamId,
          source: "dashboard",
        },
        select: {
          id: true,
          name: true,
          partialKey: true,
          subjectType: true,
          scopes: true,
          mode: true,
          createdAt: true,
          lastUsed: true,
          user: {
            select: {
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return res.status(200).json(
        tokens.map((token) => ({
          ...token,
          subjectType: parseRestrictedTokenSubjectType(token.subjectType),
        })),
      );
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Error fetching tokens" });
    }
  } else if (req.method === "POST") {
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { teamId } = req.query as { teamId: string };
    const userId = (session.user as CustomUser).id;
    const {
      name,
      scopes,
      subjectType: rawSubjectType,
    } = req.body as {
      name: string;
      scopes?: string[] | string;
      subjectType?: string;
    };

    try {
      // Check if user is in team
      const { role } = await prisma.userTeam.findUniqueOrThrow({
        where: {
          userId_teamId: {
            userId,
            teamId,
          },
        },
        select: {
          role: true,
        },
      });

      // Only admins and managers can create tokens
      if (role !== "ADMIN" && role !== "MANAGER") {
        return res.status(403).json({
          error:
            "You don't have the permissions to create a token. Please contact your administrator or manager.",
        });
      }

      // Validate name up front so a missing / non-string / whitespace-only
      // value produces a 400 instead of bubbling up as a Prisma 500.
      if (typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ error: "Name is required" });
      }

      const normalizedName = name.trim();
      const parsedSubjectType = RestrictedTokenSubjectTypeSchema.safeParse(
        typeof rawSubjectType === "string"
          ? rawSubjectType.trim().toLowerCase()
          : "user",
      );
      if (!parsedSubjectType.success) {
        return res.status(400).json({
          error: "Invalid subject type. Use `user` or `machine`.",
        });
      }
      const subjectType = parsedSubjectType.data;

      // Validate scopes. Unknown scopes are rejected to avoid quiet bugs, and
      // empty scope arrays are rejected outright — historically an empty array
      // was persisted as `null` and silently treated as unrestricted access
      // by the auth layer. Callers must now declare scopes explicitly: either
      // a single preset (`apis.all` / `apis.read`) or a granular per-resource
      // list. The legacy `full-access` value is accepted as an alias for
      // `apis.all` so any out-of-tree integrations keep working.
      const ALLOWED_SCOPES: readonly string[] = [
        ...PRESET_SCOPES,
        ...GRANULAR_SCOPES,
      ];
      const rawScopesList = Array.isArray(scopes)
        ? scopes
        : typeof scopes === "string"
          ? scopes.split(/[\s,]+/).filter(Boolean)
          : [];
      // Back-compat: rewrite the legacy `full-access` literal to `apis.all`.
      const scopesList = rawScopesList.map((s) =>
        s === "full-access" ? "apis.all" : s,
      );
      if (scopesList.length === 0) {
        return res.status(400).json({
          error:
            "At least one scope is required. Use `apis.all` for full access or `apis.read` for read-only.",
        });
      }
      const invalid = scopesList.filter((s) => !ALLOWED_SCOPES.includes(s));
      if (invalid.length > 0) {
        return res
          .status(400)
          .json({ error: `Invalid scope(s): ${invalid.join(", ")}` });
      }
      // Preset scopes are mutually exclusive with everything else. If a
      // preset is present, drop any granular scopes (the auth bypass already
      // covers them); if both presets are present, prefer the more permissive
      // `apis.all`.
      let normalizedScopes: string[];
      if (scopesList.includes("apis.all")) {
        normalizedScopes = ["apis.all"];
      } else if (scopesList.includes("apis.read")) {
        normalizedScopes = ["apis.read"];
      } else {
        normalizedScopes = Array.from(new Set(scopesList));
      }
      const scopesString = normalizedScopes.join(" ");

      // Always issue a live token. Test mode (pm_test_) was reserved but
      // never implemented — see lib/id-helper.ts for the deprecation note.
      const token = newId("tokenLive");
      const hashedToken = hashToken(token);
      const partialKey = `${token.slice(0, 11)}...${token.slice(-4)}`;

      await prisma.restrictedToken.create({
        data: {
          name: normalizedName,
          hashedKey: hashedToken,
          partialKey,
          scopes: scopesString,
          mode: "live",
          source: "dashboard",
          subjectType,
          teamId,
          userId,
        },
      });

      // Return token only once
      return res.status(200).json({ token });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Error creating token" });
    }
  } else if (req.method === "DELETE") {
    try {
      const session = await getServerSession(req, res, authOptions);
      if (!session) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { teamId } = req.query as { teamId: string };
      const { tokenId } = req.body;
      const userId = (session.user as CustomUser).id;

      // Check if user is in team and has admin role
      const { role } = await prisma.userTeam.findUniqueOrThrow({
        where: {
          userId_teamId: {
            userId,
            teamId,
          },
        },
        select: {
          role: true,
        },
      });

      // Only admins can delete tokens
      if (role !== "ADMIN") {
        return res.status(403).json({
          error:
            "You don't have the permissions to delete a token. Please contact your administrator.",
        });
      }

      // Delete the token
      const deleted = await prisma.restrictedToken.deleteMany({
        where: {
          id: tokenId,
          teamId,
          source: "dashboard",
        },
      });

      if (deleted.count === 0) {
        return res.status(404).json({ error: "Token not found" });
      }

      return res.status(200).json({ message: "Token deleted successfully" });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Error deleting token" });
    }
  } else {
    res.setHeader("Allow", ["GET", "POST", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
}
