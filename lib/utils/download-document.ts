/**
 * Trigger a document download from one of the link-scoped download
 * endpoints (`/api/links/download` or `/api/links/download/dataroom-document`).
 *
 * The server returns one of two response shapes:
 *
 *  1. A buffered binary response (currently only watermarked PDFs that need
 *     mupdf annotation) with `Content-Disposition` set to the desired
 *     filename. We turn it into a blob + `<a download>` to save it.
 *
 *  2. A JSON response of the form `{ downloadUrl, fileName }`. The URL is
 *     a CloudFront / S3 presigned URL with `response-content-disposition`
 *     baked in, so we just iframe-redirect to it. The browser streams the
 *     bytes straight from origin and saves the file with the right name -
 *     no proxying through the JS heap.
 *
 * `fallbackFileName` is used only when the buffered response is missing
 * its `Content-Disposition` header (shouldn't happen in practice).
 */
export async function downloadFromLinkEndpoint({
  endpoint,
  body,
  fallbackFileName,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  fallbackFileName: string;
}): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Failed to download file");
  }

  const contentType = response.headers.get("content-type");

  if (contentType?.includes("application/json")) {
    const { downloadUrl } = (await response.json()) as { downloadUrl: string };

    const iframe = window.document.createElement("iframe");
    iframe.style.display = "none";
    window.document.body.appendChild(iframe);
    iframe.src = downloadUrl;

    setTimeout(() => {
      if (iframe.parentNode) {
        window.document.body.removeChild(iframe);
      }
    }, 5000);

    return;
  }

  // Buffered binary response (e.g. watermarked PDF).
  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);

  const link = window.document.createElement("a");
  link.href = objectUrl;
  link.rel = "noopener noreferrer";
  link.download =
    extractFilenameFromContentDisposition(
      response.headers.get("content-disposition"),
    ) ?? fallbackFileName;

  window.document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    window.URL.revokeObjectURL(objectUrl);
    if (link.parentNode) {
      window.document.body.removeChild(link);
    }
  }, 100);
}

/**
 * Parse a `Content-Disposition` header. Prefers RFC 5987's
 * `filename*=UTF-8''<encoded>` form so unicode filenames survive, and falls
 * back to the legacy quoted-string `filename="..."` form.
 */
export function extractFilenameFromContentDisposition(
  disposition: string | null,
): string | null {
  if (!disposition) return null;

  const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1]);
    } catch {
      return starMatch[1];
    }
  }

  const quotedMatch = disposition.match(/filename="([^"]+)"/);
  if (quotedMatch && quotedMatch[1]) return quotedMatch[1];

  return null;
}
