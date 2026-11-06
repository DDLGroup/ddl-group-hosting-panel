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

  // Also auto-sync to assigned server node (e.g. ServerByte) if attached
  await syncZipBufferToExecutionNode(subdomain, zipBuffer);

  return {
    success: true,
    uploadedCount: uploadedFiles.length,
    files: uploadedFiles,
  };
}

/**
 * Automatically provisions a website directory and starter files on the execution node (e.g. ServerByte).
 */
export async function provisionExecutionNodeSite(
  subdomain: string,
  serverNodeId?: string | null
): Promise<{ success: boolean; message?: string }> {
  try {
    const supabaseAdmin = getSupabaseAdminClient();
    let nodeId = serverNodeId;

    if (!nodeId) {
      const { data: project } = await supabaseAdmin
        .from("hosting_projects")
        .select("server_node_id")
        .eq("subdomain", subdomain)
        .maybeSingle();
      nodeId = project?.server_node_id;
    }

    if (!nodeId) {
      const { data: activeNode } = await supabaseAdmin
        .from("server_nodes")
        .select("id")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      nodeId = activeNode?.id || null;
    }

    if (!nodeId) {
      console.warn(`[Node Provision] No active server node found for ${subdomain}.`);
      return { success: false, message: "No active server node found" };
    }

    const { data: node } = await supabaseAdmin
      .from("server_nodes")
      .select("*")
      .eq("id", nodeId)
      .maybeSingle();

    if (!node || !node.capabilities?.bridge_url || !node.capabilities?.token) {
      console.warn(`[Node Provision] Node ${nodeId} missing bridge credentials.`);
      return { success: false, message: "Node missing bridge credentials" };
    }

    const form = new FormData();
    form.append("action", "provision_site");
    form.append("slug", subdomain);

    const res = await fetch(node.capabilities.bridge_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${node.capabilities.token}`,
      },
      body: form,
    });

    const resData = await res.json().catch(() => ({}));
    console.log(`[Node Provision] Provisioned ${subdomain} on ${node.name}: HTTP ${res.status}`, resData);
    return { success: res.ok, message: resData?.message || "Provisioned" };
  } catch (err: any) {
    console.warn(`[Node Provision] Error provisioning site on execution node:`, err);
    return { success: false, message: err?.message || "Unknown error" };
  }
}

/**
 * Automatically synchronizes website files to the assigned Execution Node (e.g. ServerByte).
 * Files are extracted and deployed to public_html/ddl-group-hosting/sites/{subdomain}/*
 */
export async function syncFilesToExecutionNode(
  subdomain: string,
  files: Array<{ path: string; buffer: Buffer }>
) {
  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const { data: project } = await supabaseAdmin
      .from("hosting_projects")
      .select("id, subdomain, server_node_id")
      .eq("subdomain", subdomain)
      .maybeSingle();

    let nodeId = project?.server_node_id;

    // Auto-resolve to default active node if not assigned
    if (!nodeId) {
      const { data: activeNode } = await supabaseAdmin
        .from("server_nodes")
        .select("id")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (activeNode) {
        nodeId = activeNode.id;
        if (project?.id) {
          await supabaseAdmin
            .from("hosting_projects")
            .update({ server_node_id: activeNode.id })
            .eq("id", project.id);
        }
      }
    }

    if (!nodeId) return;

    const { data: node } = await supabaseAdmin
      .from("server_nodes")
      .select("*")
      .eq("id", nodeId)
      .maybeSingle();

    if (!node || !node.capabilities?.bridge_url || !node.capabilities?.token) return;

    // Pack the files into a ZIP archive in memory
    const zip = new AdmZip();
    for (const f of files) {
      zip.addFile(f.path, f.buffer);
    }
    const zipBuffer = zip.toBuffer();

    const form = new FormData();
    form.append("action", "deploy_zip");
    form.append("slug", subdomain);
    const blob = new Blob([zipBuffer], { type: "application/zip" });
    form.append("zip_file", blob, "bundle.zip");

    const res = await fetch(node.capabilities.bridge_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${node.capabilities.token}`,
      },
      body: form,
    });

    console.log(`[Node Sync] Synced ${files.length} file(s) for ${subdomain} to ${node.name}: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[Node Sync] Error syncing files to execution node:`, err);
  }
}

export async function syncZipBufferToExecutionNode(subdomain: string, zipBuffer: Buffer) {
  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const { data: project } = await supabaseAdmin
      .from("hosting_projects")
      .select("id, subdomain, server_node_id")
      .eq("subdomain", subdomain)
      .maybeSingle();

    let nodeId = project?.server_node_id;

    // Auto-resolve to default active node if not assigned
    if (!nodeId) {
      const { data: activeNode } = await supabaseAdmin
        .from("server_nodes")
        .select("id")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (activeNode) {
        nodeId = activeNode.id;
        if (project?.id) {
          await supabaseAdmin
            .from("hosting_projects")
            .update({ server_node_id: activeNode.id })
            .eq("id", project.id);
        }
      }
    }

    if (!nodeId) return;

    const { data: node } = await supabaseAdmin
      .from("server_nodes")
      .select("*")
      .eq("id", nodeId)
      .maybeSingle();

    if (!node || !node.capabilities?.bridge_url || !node.capabilities?.token) return;

    const form = new FormData();
    form.append("action", "deploy_zip");
    form.append("slug", subdomain);
    const blob = new Blob([zipBuffer], { type: "application/zip" });
    form.append("zip_file", blob, "bundle.zip");

    const res = await fetch(node.capabilities.bridge_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${node.capabilities.token}`,
      },
      body: form,
    });

    console.log(`[Node Sync] Deployed ZIP for ${subdomain} to ${node.name}: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[Node Sync] Error deploying ZIP to execution node:`, err);
  }
}

/**
 * Automatically purges website files from the assigned Execution Node (e.g. ServerByte).
 */
export async function purgeExecutionNodeSite(subdomain: string, serverNodeId?: string | null) {
  try {
    const supabaseAdmin = getSupabaseAdminClient();
    let nodeId = serverNodeId;
    if (!nodeId) {
      const { data: project } = await supabaseAdmin
        .from("hosting_projects")
        .select("server_node_id")
        .eq("subdomain", subdomain)
        .maybeSingle();
      nodeId = project?.server_node_id;
    }

    let query = supabaseAdmin.from("server_nodes").select("*");
    if (nodeId) {
      query = query.eq("id", nodeId);
    } else {
      query = query.eq("status", "active");
    }

    const { data: nodes } = await query;
    const targetNodes = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];

    for (const node of targetNodes) {
      if (node?.capabilities?.bridge_url && node?.capabilities?.token) {
        const form = new FormData();
        form.append("action", "delete_site");
        form.append("slug", subdomain);

        const res = await fetch(node.capabilities.bridge_url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${node.capabilities.token}`,
          },
          body: form,
        });

        console.log(`[Node Purge] Purged ${subdomain} from ${node.name}: HTTP ${res.status}`);
      }
    }
  } catch (err) {
    console.warn(`[Node Purge] Error purging site from execution node:`, err);
  }
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
