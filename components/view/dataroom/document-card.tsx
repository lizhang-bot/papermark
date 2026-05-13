import { useRouter } from "next/router";

import React from "react";

import { Download, MoreVerticalIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { timeAgo } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { downloadFromLinkEndpoint } from "@/lib/utils/download-document";
import { ensureFileExtension } from "@/lib/utils/get-content-type";
import { fileIcon } from "@/lib/utils/get-file-icon";
import {
  HIERARCHICAL_DISPLAY_STYLE,
  getHierarchicalDisplayName,
} from "@/lib/utils/hierarchical-display";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useViewerSurfaceTheme } from "@/components/view/viewer/viewer-surface-theme";

import { DocumentVersion } from "../viewer/dataroom-viewer";

type DRDocument = {
  dataroomDocumentId: string;
  id: string;
  name: string;
  downloadOnly: boolean;
  versions: DocumentVersion[];
  canDownload: boolean;
  hierarchicalIndex: string | null;
};

type DocumentsCardProps = {
  document: DRDocument;
  linkId: string;
  viewId?: string;
  isPreview: boolean;
  allowDownload: boolean;
  isProcessing?: boolean;
  dataroomIndexEnabled?: boolean;
  showLastUpdated?: boolean;
};

export default function DocumentCard({
  document,
  linkId,
  viewId,
  isPreview,
  allowDownload,
  isProcessing = false,
  dataroomIndexEnabled,
  showLastUpdated = true,
}: DocumentsCardProps) {
  const { theme, systemTheme } = useTheme();
  const { palette } = useViewerSurfaceTheme();
  const canDownload = document.canDownload && allowDownload;

  const isLight =
    theme === "light" || (theme === "system" && systemTheme === "light");
  const router = useRouter();

  // Get hierarchical display name
  const displayName = getHierarchicalDisplayName(
    document.name,
    document.hierarchicalIndex,
    dataroomIndexEnabled || false,
  );
  const { previewToken, domain, slug } = router.query as {
    previewToken?: string;
    domain?: string;
    slug?: string;
  };

  const handleDocumentClick = (e: React.MouseEvent) => {
    if (isProcessing) {
      e.preventDefault();
      toast.error(
        "Document is still processing. Please wait a moment and try again.",
      );
      return;
    }

    e.preventDefault();
    // Open in new tab
    if (domain && slug) {
      window.open(`/${slug}/d/${document.dataroomDocumentId}`, "_blank");
    } else {
      window.open(
        `/view/${linkId}/d/${document.dataroomDocumentId}${
          previewToken ? `?previewToken=${previewToken}&preview=1` : ""
        }`,
        "_blank",
      );
    }
  };

  const downloadDocument = async () => {
    if (isPreview) {
      toast.error("You cannot download dataroom document in preview mode.");
      return;
    }

    const downloadPromise = downloadFromLinkEndpoint({
      endpoint: "/api/links/download/dataroom-document",
      body: { linkId, viewId, documentId: document.id },
      fallbackFileName: ensureFileExtension({
        name: document.name,
        type: document.versions[0]?.type,
      }),
    });

    toast.promise(downloadPromise, {
      loading: "Preparing download...",
      success: "File downloaded successfully",
      error: (err) => err.message || "Failed to download file",
    });
  };

  return (
    <div
      className={cn(
        "group/row relative flex items-center justify-between rounded-lg border p-3 transition-all sm:p-4",
        "bg-[var(--viewer-panel-bg)] hover:bg-[var(--viewer-panel-bg-hover)]",
        "border-[var(--viewer-panel-border)] hover:border-[var(--viewer-panel-border-hover)]",
        isProcessing && "cursor-not-allowed opacity-60",
      )}
      style={
        {
          "--viewer-panel-bg": palette.panelBgColor,
          "--viewer-panel-bg-hover": palette.panelHoverBgColor,
          "--viewer-panel-border": palette.panelBorderColor,
          "--viewer-panel-border-hover": palette.panelBorderHoverColor,
          "--viewer-text": palette.textColor,
          "--viewer-muted-text": palette.mutedTextColor,
          "--viewer-control-bg": palette.controlBgColor,
          "--viewer-control-border": palette.controlBorderColor,
          "--viewer-control-border-strong": palette.controlBorderStrongColor,
          "--viewer-control-icon": palette.controlIconColor,
        } as React.CSSProperties
      }
    >
      {/* Click target - outside of text hierarchy to fix Safari truncation issue */}
      <button
        onClick={handleDocumentClick}
        className="absolute inset-0 z-0 cursor-pointer"
        disabled={isProcessing}
        aria-hidden="true"
      />
      <div className="flex min-w-0 shrink items-center space-x-2 sm:space-x-4">
        <div className="mx-0.5 flex w-8 items-center justify-center text-center sm:mx-1">
          {fileIcon({
            fileType: document.versions[0].type ?? "",
            className: "h-8 w-8",
            isLight,
          })}
        </div>

        <div className="min-w-0 flex-1 flex-col">
          <div className="flex items-center">
            <h2
              className="truncate text-sm font-semibold leading-6 text-[var(--viewer-text)]"
              style={HIERARCHICAL_DISPLAY_STYLE}
            >
              {displayName}
              {isProcessing && (
                <span
                  className="ml-2 text-xs text-[var(--viewer-muted-text)]"
                >
                  (Processing...)
                </span>
              )}
            </h2>
          </div>
          {showLastUpdated && (
            <div
              className="mt-1 flex items-center space-x-1 text-xs leading-5 text-[var(--viewer-muted-text)]"
            >
              <p className="truncate">
                Updated {timeAgo(document.versions[0].updatedAt)}
              </p>
            </div>
          )}
        </div>
      </div>
      {canDownload && !isProcessing && (
        <div className="z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-8 w-8 border bg-transparent p-0",
                  "text-[var(--viewer-control-icon)] border-[var(--viewer-control-border)] hover:bg-[var(--viewer-control-bg)]",
                  "group-hover/row:text-[var(--viewer-text)] group-hover/row:border-[var(--viewer-control-border-strong)]",
                )}
                aria-label="Open menu"
              >
                <MoreVerticalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  downloadDocument();
                }}
              >
                <Download className="h-4 w-4" />
                Download
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
