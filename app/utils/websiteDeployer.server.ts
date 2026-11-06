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

  const fileEntries = zipEntries.filter(
    (e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX") && !e.entryName.includes(".DS_Store")
  );

  if (fileEntries.length === 0) {
    throw new Error("No deployable web files found in the archive.");
  }

  const firstPathSegments = fileEntries.map((e) => e.entryName.split("/")[0]);
  const hasCommonRoot = firstPathSegments.every((seg) => seg === firstPathSegments[0]) && firstPathSegments[0] !== "";

  const uploadedFiles: string[] = [];

  for (const entry of fileEntries) {
    let cleanPath = entry.entryName;
    if (hasCommonRoot) {
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

/**
 * Serves a website asset from Supabase Storage by subdomain and file path.
 */
export async function serveCloudWebsiteFile(subdomain: string, rawPath: string = "index.html") {
  if (!rawPath || rawPath === "" || rawPath.endsWith("/")) {
    rawPath += "index.html";
  }

  const supabaseAdmin = getSupabaseAdminClient();

  let { data: fileBlob, error } = await supabaseAdmin.storage
    .from("client-websites")
    .download(`${subdomain}/${rawPath}`);

  if (error || !fileBlob) {
    if (!rawPath.includes(".")) {
      const fallbackResult = await supabaseAdmin.storage
        .from("client-websites")
        .download(`${subdomain}/${rawPath}/index.html`);

      if (!fallbackResult.error && fallbackResult.data) {
        fileBlob = fallbackResult.data;
        rawPath += "/index.html";
        error = null;
      } else {
        const htmlFallback = await supabaseAdmin.storage
          .from("client-websites")
          .download(`${subdomain}/${rawPath}.html`);

        if (!htmlFallback.error && htmlFallback.data) {
          fileBlob = htmlFallback.data;
          rawPath += ".html";
          error = null;
        }
      }
    }
  }

  if (error || !fileBlob) {
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <title>404 Not Found | DDL Group Hosting</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { text-align: center; max-width: 480px; padding: 2rem; background: #1e293b; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #334155; }
    h1 { font-size: 2.5rem; margin: 0 0 0.5rem; color: #38bdf8; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .badge { font-size: 0.75rem; text-transform: uppercase; font-weight: bold; background: #0284c7; padding: 0.25rem 0.75rem; border-radius: 9999px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">DDL Group Cloud Hosting</span>
    <h1>404 Not Found</h1>
    <p>The requested file (<code>${rawPath}</code>) does not exist on website <strong>${subdomain}</strong>.</p>
  </div>
</body>
</html>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  const arrayBuffer = await fileBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = getMimeType(rawPath);

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
      "X-Powered-By": "DDL Group Cloud Hosting Engine",
    },
  });
}

/**
 * Inspects incoming Host header and serves custom domain website if mapped.
 */
export async function handleCustomDomainRequest(request: Request, relativePath: string = "index.html") {
  const hostHeader = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  const host = hostHeader.split(":")[0].toLowerCase();

  const internalHosts = [
    "localhost",
    "127.0.0.1",
    "ddl-group-hosting-panel.netlify.app",
    "panel.ddlg.in",
    "hosting.ddlg.in",
  ];

  if (!host || internalHosts.includes(host)) {
    return null;
  }

  const supabaseAdmin = getSupabaseAdminClient();
  const { data: domainRecord } = await supabaseAdmin
    .from("domains")
    .select("project_id, hosting_projects(subdomain)")
    .eq("domain_name", host)
    .maybeSingle();

  if (!domainRecord || !domainRecord.hosting_projects) {
    return null;
  }

  const subdomain = (domainRecord.hosting_projects as any).subdomain;
  return serveCloudWebsiteFile(subdomain, relativePath);
}

/**
 * Recursively deletes all files stored in Supabase Storage under client-websites/{subdomain}/
 */
export async function deleteAllCloudWebsiteFiles(subdomain: string): Promise<{ deletedCount: number }> {
  const supabaseAdmin = getSupabaseAdminClient();

  async function listAllPaths(folder: string): Promise<string[]> {
    const { data: items, error } = await supabaseAdmin.storage
      .from("client-websites")
      .list(folder, { limit: 1000 });

    if (error || !items || items.length === 0) return [];

    let allFiles: string[] = [];
    for (const item of items) {
      const fullPath = folder ? `${folder}/${item.name}` : item.name;
      if (item.id) {
        allFiles.push(fullPath);
      } else {
        const nested = await listAllPaths(fullPath);
        allFiles = allFiles.concat(nested);
      }
    }
    return allFiles;
  }

  try {
    const filesToDelete = await listAllPaths(subdomain);
    if (filesToDelete.length > 0) {
      await supabaseAdmin.storage.from("client-websites").remove(filesToDelete);
    }
    return { deletedCount: filesToDelete.length };
  } catch (err) {
    console.error(`[Storage] Failed to delete website files for ${subdomain}:`, err);
    return { deletedCount: 0 };
  }
}

/**
 * Recursively deletes a specific folder under client-websites/{subdomain}/{folderPath}
 */
export async function deleteStorageFolder(subdomain: string, folderPath: string): Promise<number> {
  const supabaseAdmin = getSupabaseAdminClient();
  const rootPrefix = `${subdomain}/${folderPath}`.replace(/\/+$/, "");

  async function listAllPaths(folder: string): Promise<string[]> {
    const { data: items, error } = await supabaseAdmin.storage
      .from("client-websites")
      .list(folder, { limit: 1000 });

    if (error || !items || items.length === 0) return [];

    let allFiles: string[] = [];
    for (const item of items) {
      const fullPath = `${folder}/${item.name}`;
      if (item.id) {
        allFiles.push(fullPath);
      } else {
        const nested = await listAllPaths(fullPath);
        allFiles = allFiles.concat(nested);
      }
    }
    return allFiles;
  }

  try {
    const filesToDelete = await listAllPaths(rootPrefix);
    if (filesToDelete.length > 0) {
      await supabaseAdmin.storage.from("client-websites").remove(filesToDelete);
    }
    return filesToDelete.length;
  } catch (err) {
    console.error(`[Storage] Failed to delete folder ${rootPrefix}:`, err);
    return 0;
  }
}

/**
 * Extracts a ZIP file in place into client-websites/{subdomain}/{currentPath}
 */
export async function extractZipArchive(
  subdomain: string,
  zipRelativePath: string,
  currentPath: string = ""
): Promise<number> {
  const supabaseAdmin = getSupabaseAdminClient();
  const storageKey = `${subdomain}/${zipRelativePath}`;

  const { data: zipBlob, error } = await supabaseAdmin.storage
    .from("client-websites")
    .download(storageKey);

  if (error || !zipBlob) {
    throw new Error(`Failed to download ZIP file: ${error?.message || "File not found"}`);
  }

  const arrayBuffer = await zipBlob.arrayBuffer();
  const zip = new AdmZip(Buffer.from(arrayBuffer));
  const entries = zip.getEntries();

  let extractedCount = 0;
  const targetDir = currentPath ? `${currentPath}/`.replace(/\/+$/, "/") : "";

  for (const entry of entries) {
    if (entry.isDirectory || entry.entryName.startsWith("__MACOSX") || entry.entryName.includes(".DS_Store")) {
      continue;
    }

    const cleanEntryName = entry.entryName.replace(/^(\/|\\)+/, "");
    const destinationPath = `${subdomain}/${targetDir}${cleanEntryName}`;
    const contentType = getMimeType(cleanEntryName);

    await supabaseAdmin.storage
      .from("client-websites")
      .upload(destinationPath, entry.getData(), {
        contentType,
        upsert: true,
      });

    extractedCount++;
  }

  return extractedCount;
}

/**
 * Compresses selected files and folders into a downloadable ZIP archive
 */
export async function compressStorageItems(
  subdomain: string,
  relativePaths: string[],
  currentPath: string = ""
): Promise<string> {
  const supabaseAdmin = getSupabaseAdminClient();
  const zip = new AdmZip();

  for (const relPath of relativePaths) {
    const fullKey = `${subdomain}/${relPath}`;
    const itemName = relPath.split("/").pop() || relPath;

    // Check if it's a file by trying to download it
    const { data: fileBlob } = await supabaseAdmin.storage
      .from("client-websites")
      .download(fullKey);

    if (fileBlob) {
      const buf = Buffer.from(await fileBlob.arrayBuffer());
      zip.addFile(itemName, buf);
    } else {
      // It's likely a directory, list and add files
      const { data: items } = await supabaseAdmin.storage
        .from("client-websites")
        .list(fullKey, { limit: 1000 });

      if (items) {
        for (const item of items) {
          if (item.id) {
            const nestedKey = `${fullKey}/${item.name}`;
            const { data: subBlob } = await supabaseAdmin.storage
              .from("client-websites")
              .download(nestedKey);
            if (subBlob) {
              const subBuf = Buffer.from(await subBlob.arrayBuffer());
              zip.addFile(`${itemName}/${item.name}`, subBuf);
            }
          }
        }
      }
    }
  }

  const archiveName = `archive-${Date.now().toString(36)}.zip`;
  const targetDir = currentPath ? `${currentPath}/`.replace(/\/+$/, "/") : "";
  const uploadKey = `${subdomain}/${targetDir}${archiveName}`;

  await supabaseAdmin.storage
    .from("client-websites")
    .upload(uploadKey, zip.toBuffer(), {
      contentType: "application/zip",
      upsert: true,
    });

  return archiveName;
}
