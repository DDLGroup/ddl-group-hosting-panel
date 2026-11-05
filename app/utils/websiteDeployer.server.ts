import AdmZip from "adm-zip";
import { getSupabaseAdminClient } from "./supabase.server";

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
};

export function getMimeType(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return "application/octet-stream";
  const ext = filename.slice(lastDot).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

/**
 * Extracts a ZIP archive and uploads all web assets to Supabase Storage.
 * Subdomain acts as the root folder: client-websites/{subdomain}/{filepath}
 */
export async function deployZipToCloudStorage(subdomain: string, zipBuffer: Buffer) {
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();
  const supabaseAdmin = getSupabaseAdminClient();

  if (zipEntries.length === 0) {
    throw new Error("The uploaded ZIP archive is empty.");
  }

  // Check if all files are inside a single root folder (e.g. dist/ or mywebsite/)
  const fileEntries = zipEntries.filter(
    (e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX") && !e.entryName.includes(".DS_Store")
  );

  if (fileEntries.length === 0) {
    throw new Error("No deployable web files found in the archive.");
  }

  // Determine if there is a common parent folder
  const firstPathSegments = fileEntries.map((e) => e.entryName.split("/")[0]);
  const hasCommonRoot = firstPathSegments.every((seg) => seg === firstPathSegments[0]) && firstPathSegments[0] !== "";

  const uploadedFiles: string[] = [];

  for (const entry of fileEntries) {
    let cleanPath = entry.entryName;
    if (hasCommonRoot) {
      // Strip common root folder
      cleanPath = cleanPath.split("/").slice(1).join("/");
    }

    if (!cleanPath) continue;

    const fileBuffer = entry.getData();
    const contentType = getMimeType(cleanPath);

    const storagePath = `${subdomain}/${cleanPath}`;

    const { error } = await supabaseAdmin.storage
      .from("client-websites")
      .upload(storagePath, fileBuffer, {
        upsert: true,
        contentType,
      });

    if (error) {
      console.error(`Failed to upload ${cleanPath}:`, error.message);
    } else {
      uploadedFiles.push(cleanPath);
    }
  }

  return {
    success: true,
    uploadedCount: uploadedFiles.length,
    files: uploadedFiles,
  };
}
