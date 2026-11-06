import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import {
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import Button from "~/components/Button";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";
import {
  compressStorageItems,
  deleteAllCloudWebsiteFiles,
  deleteStorageFolder,
  deployZipToCloudStorage,
  extractZipArchive,
  getMimeType,
  syncFilesToExecutionNode,
} from "~/utils/websiteDeployer.server";

export const meta: MetaFunction = () => {
  return [{ title: "File Manager | DDL Group Hosting Panel" }];
};

function sanitizePath(rawPath: string): string {
  return rawPath
    .replace(/^(\/|\\)+/, "")
    .replace(/(\/|\\)+$/, "")
    .split(/[\/\\]/)
    .filter((segment) => segment && segment !== ".." && segment !== ".")
    .join("/");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  let query = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain, runtime")
    .order("created_at", { ascending: false });

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const { data: projects } = await query;

  const url = new URL(request.url);
  const selectedProjectId = url.searchParams.get("project") || projects?.[0]?.id || "";
  const selectedProject = projects?.find((p) => p.id === selectedProjectId);
  const currentPath = sanitizePath(url.searchParams.get("path") || "");

  let items: Array<{
    name: string;
    isFolder: boolean;
    relativePath: string;
    size: string;
    rawSize: number;
    updated_at?: string;
    permissions: string;
    extension: string;
  }> = [];

  if (selectedProject?.subdomain) {
    const listPrefix = currentPath
      ? `${selectedProject.subdomain}/${currentPath}`
      : selectedProject.subdomain;

    const { data: storageList } = await supabaseAdmin.storage
      .from("client-websites")
      .list(listPrefix, { limit: 500, sortBy: { column: "name", order: "asc" } });

    if (storageList) {
      // Filter out hidden bookkeeping files like .keep
      const filtered = storageList.filter((item) => item.name !== ".keep");

      items = filtered.map((item) => {
        const isFolder = !item.id;
        const relativePath = currentPath ? `${currentPath}/${item.name}` : item.name;
        const ext = isFolder ? "" : item.name.split(".").pop()?.toLowerCase() || "";

        return {
          name: item.name,
          isFolder,
          relativePath,
          size: isFolder ? "—" : formatBytes(item.metadata?.size || 0),
          rawSize: item.metadata?.size || 0,
          updated_at: item.updated_at,
          permissions: isFolder ? "0755" : "0644",
          extension: ext,
        };
      });

      // Sort: Folders first (A-Z), then Files (A-Z)
      items.sort((a, b) => {
        if (a.isFolder === b.isFolder) {
          return a.name.localeCompare(b.name);
        }
        return a.isFolder ? -1 : 1;
      });
    }
  }

  // Calculate breadcrumbs
  const pathParts = currentPath ? currentPath.split("/") : [];
  const breadcrumbs = [{ label: "root", path: "" }];
  let accumulated = "";
  for (const part of pathParts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    breadcrumbs.push({ label: part, path: accumulated });
  }

  return Response.json({
    projects: projects || [],
    selectedProjectId,
    selectedProject,
    currentPath,
    breadcrumbs,
    items,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  const uploadHandler = unstable_createMemoryUploadHandler({
    maxPartSize: 50 * 1024 * 1024, // 50MB
  });

  const formData = await unstable_parseMultipartFormData(request, uploadHandler);
  const intent = String(formData.get("intent") || "");
  const projectId = String(formData.get("project_id") || "");
  const currentPath = sanitizePath(String(formData.get("current_path") || ""));

  if (!projectId) {
    return Response.json({ error: "Please select a target website." }, { status: 400 });
  }

  // Verify ownership
  let query = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain, runtime, server_node_id, customer_id")
    .eq("id", projectId);

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const { data: project, error: projErr } = await query.maybeSingle();

  if (projErr || !project) {
    return Response.json({ error: "Project not found or access denied." }, { status: 404 });
  }

  const targetPrefix = currentPath ? `${currentPath}/`.replace(/\/+$/, "/") : "";

  // 1. Upload one or multiple individual files (with overwrite / overlap)
  if (intent === "upload_files") {
    const rawFiles = formData.getAll("uploaded_files");
    const validFiles = rawFiles.filter(
      (f): f is File => f instanceof File && f.size > 0 && typeof f.name === "string" && f.name.trim() !== ""
    );

    if (validFiles.length === 0) {
      return Response.json({ error: "No files were selected for upload." }, { status: 400 });
    }

    let uploadedCount = 0;
    const filesToSync: Array<{ path: string; buffer: Buffer }> = [];
    for (const f of validFiles) {
      const cleanFileName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageKey = `${project.subdomain}/${targetPrefix}${cleanFileName}`;
      const buffer = Buffer.from(await f.arrayBuffer());
      const contentType = getMimeType(cleanFileName);

      const { error: upErr } = await supabaseAdmin.storage
        .from("client-websites")
        .upload(storageKey, buffer, {
          contentType,
          upsert: true, // Overwrites ("paste over") existing file
        });

      if (!upErr) {
        uploadedCount++;
        filesToSync.push({ path: `${targetPrefix}${cleanFileName}`, buffer });
      }
    }

    if (filesToSync.length > 0) {
      await syncFilesToExecutionNode(project.subdomain, filesToSync);
    }

    return Response.json({
      success: `Successfully uploaded and synced ${uploadedCount} file(s) into /${currentPath || "root"} (overwrote any existing files).`,
    });
  }

  // 2. Deploy Full ZIP website bundle
  if (intent === "deploy_zip") {
    const zipFile = formData.get("zip_file") as File | null;
    if (!zipFile || !(zipFile instanceof File) || zipFile.size === 0) {
      return Response.json({ error: "Please select a valid .ZIP website archive." }, { status: 400 });
    }

    try {
      const buffer = Buffer.from(await zipFile.arrayBuffer());
      const result = await deployZipToCloudStorage(project.subdomain, buffer);

      await supabaseAdmin.from("deployments").insert({
        project_id: project.id,
        version_number: 1,
        runtime: project.runtime || "static",
        source_type: "zip_upload",
        status: "deployed",
        commit_message: `Uploaded ZIP: ${zipFile.name} (${result.uploadedCount} files deployed)`,
        deployed_by: profile.id,
        logs: `Extracted and deployed ${result.uploadedCount} files to cloud storage for ${project.subdomain}.`,
      });

      return Response.json({
        success: `Successfully deployed ${result.uploadedCount} files from ZIP archive!`,
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to process ZIP." }, { status: 500 });
    }
  }

  // 3. Create New File
  if (intent === "create_file") {
    const fileName = String(formData.get("file_name") || "").trim();
    const initialContent = String(formData.get("initial_content") || "");

    if (!fileName) {
      return Response.json({ error: "File name is required." }, { status: 400 });
    }

    const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storageKey = `${project.subdomain}/${targetPrefix}${cleanFileName}`;
    const contentType = getMimeType(cleanFileName);
    const buffer = Buffer.from(initialContent, "utf-8");

    const { error: createErr } = await supabaseAdmin.storage
      .from("client-websites")
      .upload(storageKey, buffer, {
        contentType,
        upsert: true,
      });

    if (createErr) {
      return Response.json({ error: createErr.message }, { status: 500 });
    }

    await syncFilesToExecutionNode(project.subdomain, [
      { path: `${targetPrefix}${cleanFileName}`, buffer },
    ]);

    return Response.json({ success: `File "${cleanFileName}" created successfully!` });
  }

  // 4. Create New Folder
  if (intent === "create_folder") {
    const folderName = String(formData.get("folder_name") || "").trim();
    if (!folderName) {
      return Response.json({ error: "Folder name is required." }, { status: 400 });
    }

    const cleanFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const placeholderKey = `${project.subdomain}/${targetPrefix}${cleanFolderName}/.keep`;

    const { error: folderErr } = await supabaseAdmin.storage
      .from("client-websites")
      .upload(placeholderKey, Buffer.from(""), {
        contentType: "text/plain",
        upsert: true,
      });

    if (folderErr) {
      return Response.json({ error: folderErr.message }, { status: 500 });
    }

    await syncFilesToExecutionNode(project.subdomain, [
      { path: `${targetPrefix}${cleanFolderName}/.keep`, buffer: Buffer.from("") },
    ]);

    return Response.json({ success: `Folder "${cleanFolderName}" created successfully!` });
  }

  // 5. Delete Selected Item(s)
  if (intent === "delete_items") {
    const pathsRaw = String(formData.get("paths") || "");
    let paths: string[] = [];

    try {
      paths = JSON.parse(pathsRaw);
    } catch {
      paths = [pathsRaw].filter(Boolean);
    }

    if (paths.length === 0) {
      return Response.json({ error: "No items selected to delete." }, { status: 400 });
    }

    let deletedCount = 0;
    for (const relPath of paths) {
      const cleanRelPath = sanitizePath(relPath);
      // Check if it's a folder or file by attempting to delete as folder first or file
      const count = await deleteStorageFolder(project.subdomain, cleanRelPath);
      if (count > 0) {
        deletedCount += count;
      } else {
        // Single file deletion
        const fullKey = `${project.subdomain}/${cleanRelPath}`;
        const { error: removeErr } = await supabaseAdmin.storage
          .from("client-websites")
          .remove([fullKey]);
        if (!removeErr) deletedCount++;
      }
    }

    return Response.json({ success: `Permanently deleted ${deletedCount} item(s).` });
  }

  // 6. Extract ZIP Archive
  if (intent === "extract_zip") {
    const zipPath = sanitizePath(String(formData.get("zip_path") || ""));
    if (!zipPath || !zipPath.toLowerCase().endsWith(".zip")) {
      return Response.json({ error: "Please select a valid .ZIP file to extract." }, { status: 400 });
    }

    try {
      const extractedCount = await extractZipArchive(project.subdomain, zipPath, currentPath);
      return Response.json({
        success: `Successfully extracted ${extractedCount} file(s) into /${currentPath || "root"}.`,
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to extract ZIP archive." }, { status: 500 });
    }
  }

  // 7. Compress Selected Items into ZIP Archive
  if (intent === "compress_items") {
    const pathsRaw = String(formData.get("paths") || "");
    let paths: string[] = [];

    try {
      paths = JSON.parse(pathsRaw);
    } catch {
      paths = [pathsRaw].filter(Boolean);
    }

    if (paths.length === 0) {
      return Response.json({ error: "Please select files or folders to compress." }, { status: 400 });
    }

    try {
      const archiveName = await compressStorageItems(project.subdomain, paths, currentPath);
      return Response.json({
        success: `Created compressed archive "${archiveName}" successfully!`,
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to compress selected items." }, { status: 500 });
    }
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function FileManager() {
  const { projects, selectedProjectId, selectedProject, currentPath, breadcrumbs, items } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const isSubmitting = navigation.state === "submitting";

  // Selection state
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);

  // Modals state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showNewFileModal, setShowNewFileModal] = useState(false);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showDeployZipModal, setShowDeployZipModal] = useState(false);

  // Code Editor Modal State ("file edit in new window")
  const [editorState, setEditorState] = useState<{
    isOpen: boolean;
    filePath: string;
    fileName: string;
    content: string;
    originalContent: string;
    loading: boolean;
    saving: boolean;
    statusMsg: string;
  }>({
    isOpen: false,
    filePath: "",
    fileName: "",
    content: "",
    originalContent: "",
    loading: false,
    saving: false,
    statusMsg: "",
  });

  // Image Preview Modal State
  const [previewImage, setPreviewImage] = useState<{ isOpen: boolean; url: string; fileName: string }>({
    isOpen: false,
    url: "",
    fileName: "",
  });

  // Reset selected items on folder navigation
  useEffect(() => {
    setSelectedPaths([]);
  }, [currentPath, selectedProjectId]);

  const allSelected = items.length > 0 && selectedPaths.length === items.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedPaths([]);
    } else {
      setSelectedPaths(items.map((it: any) => it.relativePath));
    }
  };

  const toggleSelectItem = (relPath: string) => {
    if (selectedPaths.includes(relPath)) {
      setSelectedPaths(selectedPaths.filter((p) => p !== relPath));
    } else {
      setSelectedPaths([...selectedPaths, relPath]);
    }
  };

  // Open file in Code Editor
  const openCodeEditor = async (relativePath: string) => {
    const fileName = relativePath.split("/").pop() || relativePath;
    setEditorState({
      isOpen: true,
      filePath: relativePath,
      fileName,
      content: "",
      originalContent: "",
      loading: true,
      saving: false,
      statusMsg: "Loading file content...",
    });

    try {
      const res = await fetch(`/api/file-content?project=${selectedProjectId}&path=${encodeURIComponent(relativePath)}`);
      const data = await res.json();
      if (res.ok && typeof data.content === "string") {
        setEditorState((prev) => ({
          ...prev,
          content: data.content,
          originalContent: data.content,
          loading: false,
          statusMsg: `Loaded ${formatBytes(data.size)}`,
        }));
      } else {
        setEditorState((prev) => ({
          ...prev,
          loading: false,
          statusMsg: data.error || "Failed to load file content.",
        }));
      }
    } catch (err: any) {
      setEditorState((prev) => ({
        ...prev,
        loading: false,
        statusMsg: err.message || "Network error loading file.",
      }));
    }
  };

  // Save File in Code Editor
  const saveCodeEditor = async () => {
    if (!editorState.filePath) return;
    setEditorState((prev) => ({ ...prev, saving: true, statusMsg: "Saving file to cloud storage..." }));

    try {
      const body = new FormData();
      body.append("project_id", selectedProjectId);
      body.append("path", editorState.filePath);
      body.append("content", editorState.content);

      const res = await fetch("/api/file-content", {
        method: "POST",
        body,
      });

      const data = await res.json();
      if (res.ok) {
        setEditorState((prev) => ({
          ...prev,
          originalContent: prev.content,
          saving: false,
          statusMsg: `✓ Saved successfully at ${new Date().toLocaleTimeString()}!`,
        }));
      } else {
        setEditorState((prev) => ({
          ...prev,
          saving: false,
          statusMsg: `Error: ${data.error || "Failed to save file"}`,
        }));
      }
    } catch (err: any) {
      setEditorState((prev) => ({
        ...prev,
        saving: false,
        statusMsg: `Save error: ${err.message}`,
      }));
    }
  };

  const getFileIcon = (item: any) => {
    if (item.isFolder) {
      return (
        <span className="text-amber-500 text-base" title="Directory">
          📁
        </span>
      );
    }
    const ext = item.extension;
    if (["html", "htm"].includes(ext)) {
      return <span className="text-orange-500 font-bold text-xs bg-orange-50 px-1 py-0.5 rounded border border-orange-200">HTML</span>;
    }
    if (["css"].includes(ext)) {
      return <span className="text-blue-500 font-bold text-xs bg-blue-50 px-1 py-0.5 rounded border border-blue-200">CSS</span>;
    }
    if (["js", "mjs", "ts"].includes(ext)) {
      return <span className="text-yellow-600 font-bold text-xs bg-yellow-50 px-1 py-0.5 rounded border border-yellow-200">JS</span>;
    }
    if (["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"].includes(ext)) {
      return <span className="text-emerald-600 font-bold text-xs bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">IMG</span>;
    }
    if (["zip", "tar", "gz"].includes(ext)) {
      return <span className="text-purple-600 font-bold text-xs bg-purple-50 px-1 py-0.5 rounded border border-purple-200">ZIP</span>;
    }
    return <span className="text-slate-400 font-bold text-xs bg-slate-50 px-1 py-0.5 rounded border border-slate-200">DOC</span>;
  };

  const isEditable = (ext: string) => {
    return [
      "html", "htm", "css", "js", "mjs", "ts", "json", "txt", "xml", "svg",
      "md", "php", "env", "yml", "yaml", "config", "ini", "htaccess",
    ].includes(ext);
  };

  const isImage = (ext: string) => {
    return ["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"].includes(ext);
  };

  // Up one folder level
  const parentPath = currentPath.includes("/")
    ? currentPath.split("/").slice(0, -1).join("/")
    : "";

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <span>CyberPanel File Manager</span>
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800 border border-cyan-200">
              Enterprise Control
            </span>
          </h1>
          <p className="text-sm text-slate-500">
            Full file operations: browse folders, edit code in editor, upload with overwrite, extract/compress ZIPs, and batch delete
          </p>
        </div>

        {projects.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-bold text-slate-600 uppercase">Website:</label>
            <select
              value={selectedProjectId}
              onChange={(e) => {
                setSearchParams({ project: e.target.value, path: "" });
              }}
              className="px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white font-semibold text-slate-900 shadow-xs focus:ring-2 focus:ring-cyan-500"
            >
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.subdomain}.ddlgroup.host)
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {actionData?.error && (
        <div className="p-4 text-sm font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-xl">
          {actionData.error}
        </div>
      )}

      {actionData?.success && (
        <div className="p-4 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between">
          <span>✓ {actionData.success}</span>
        </div>
      )}

      {/* CyberPanel File Manager Main Container */}
      <div className="bg-white border border-slate-200 shadow-xs rounded-2xl overflow-hidden">
        {/* Navigation & Breadcrumb Bar */}
        <div className="p-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-1.5 font-mono text-slate-600 overflow-x-auto py-1">
            <span className="text-slate-400">Path:</span>
            {breadcrumbs.map((bc: any, idx: number) => (
              <span key={bc.path} className="flex items-center gap-1.5">
                {idx > 0 && <span className="text-slate-300">/</span>}
                <button
                  type="button"
                  onClick={() => setSearchParams({ project: selectedProjectId, path: bc.path })}
                  className={`px-1.5 py-0.5 rounded-md hover:bg-slate-200 font-bold ${
                    idx === breadcrumbs.length - 1 ? "text-cyan-700 bg-cyan-50" : "text-slate-700"
                  }`}
                >
                  {bc.label === "root" ? "🏠 root" : bc.label}
                </button>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {currentPath !== "" && (
              <button
                type="button"
                onClick={() => setSearchParams({ project: selectedProjectId, path: parentPath })}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 shadow-xs transition"
                title="Go up one folder"
              >
                <span>⬆ Up One Level</span>
              </button>
            )}

            {selectedProject && (
              <a
                href={`/site/${selectedProject.subdomain}/${currentPath ? currentPath + "/" : ""}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
              >
                <span>Live View</span>
                <span>↗</span>
              </a>
            )}
          </div>
        </div>

        {/* CyberPanel Action Toolbar */}
        <div className="p-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowNewFileModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 shadow-2xs transition"
            >
              <span>📄</span>
              <span>New File</span>
            </button>

            <button
              type="button"
              onClick={() => setShowNewFolderModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 shadow-2xs transition"
            >
              <span>📁</span>
              <span>New Folder</span>
            </button>

            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-2xs transition"
            >
              <span>📤</span>
              <span>Upload Files (Overlap/Paste)</span>
            </button>

            <button
              type="button"
              onClick={() => setShowDeployZipModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl hover:bg-indigo-100 transition"
            >
              <span>📦</span>
              <span>Deploy Full ZIP</span>
            </button>
          </div>

          {/* Batch operations toolbar */}
          <div className="flex items-center gap-2">
            {selectedPaths.length > 0 && (
              <>
                <Form method="POST">
                  <input type="hidden" name="intent" value="compress_items" />
                  <input type="hidden" name="project_id" value={selectedProjectId} />
                  <input type="hidden" name="current_path" value={currentPath} />
                  <input type="hidden" name="paths" value={JSON.stringify(selectedPaths)} />
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded-xl hover:bg-purple-100 transition"
                  >
                    <span>🗜️ Compress ({selectedPaths.length})</span>
                  </button>
                </Form>

                <Form
                  method="POST"
                  onSubmit={(e) => {
                    if (
                      !confirm(
                        `Are you sure you want to permanently delete ${selectedPaths.length} selected item(s)?\n\nThis will delete all selected files and folders permanently.`
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="delete_items" />
                  <input type="hidden" name="project_id" value={selectedProjectId} />
                  <input type="hidden" name="current_path" value={currentPath} />
                  <input type="hidden" name="paths" value={JSON.stringify(selectedPaths)} />
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl hover:bg-rose-100 transition"
                  >
                    <span>🗑️ Delete ({selectedPaths.length})</span>
                  </button>
                </Form>
              </>
            )}

            <button
              type="button"
              onClick={() => setSearchParams({ project: selectedProjectId, path: currentPath })}
              className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition"
              title="Refresh file list"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        {/* File Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-500 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="rounded text-cyan-600 focus:ring-cyan-500"
                  />
                </th>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4 w-28">Size</th>
                <th className="py-3 px-4 w-24">Perms</th>
                <th className="py-3 px-4 w-44">Last Modified</th>
                <th className="py-3 px-4 text-right w-48">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono text-xs">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400 font-sans">
                    <div className="space-y-2">
                      <div className="text-2xl">📂</div>
                      <p className="text-sm font-semibold text-slate-700">This directory is empty</p>
                      <p className="text-xs text-slate-400">
                        Upload files, extract a ZIP, or create new files/folders using the toolbar above.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((item: any) => {
                  const isChecked = selectedPaths.includes(item.relativePath);
                  const editable = isEditable(item.extension);
                  const img = isImage(item.extension);
                  const isZip = item.extension === "zip";

                  return (
                    <tr
                      key={item.relativePath}
                      className={`hover:bg-slate-50/80 transition-colors ${
                        isChecked ? "bg-cyan-50/50" : ""
                      }`}
                    >
                      <td className="py-2.5 px-4">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectItem(item.relativePath)}
                          className="rounded text-cyan-600 focus:ring-cyan-500"
                        />
                      </td>

                      {/* File / Folder Name with Click Actions */}
                      <td className="py-2.5 px-4 font-semibold text-slate-900">
                        <div className="flex items-center gap-2">
                          {getFileIcon(item)}

                          {item.isFolder ? (
                            <button
                              type="button"
                              onClick={() =>
                                setSearchParams({
                                  project: selectedProjectId,
                                  path: item.relativePath,
                                })
                              }
                              className="text-cyan-700 hover:underline hover:text-cyan-900 font-bold flex items-center gap-1"
                            >
                              <span>{item.name}</span>
                              <span className="text-slate-400 font-normal text-[10px]">/</span>
                            </button>
                          ) : editable ? (
                            <button
                              type="button"
                              onClick={() => openCodeEditor(item.relativePath)}
                              className="text-slate-800 hover:text-cyan-700 hover:underline text-left"
                              title="Click to Edit in Code Editor"
                            >
                              {item.name}
                            </button>
                          ) : img ? (
                            <button
                              type="button"
                              onClick={() =>
                                setPreviewImage({
                                  isOpen: true,
                                  url: `/site/${selectedProject?.subdomain}/${item.relativePath}`,
                                  fileName: item.name,
                                })
                              }
                              className="text-slate-800 hover:text-cyan-700 hover:underline text-left"
                              title="Click to Preview Image"
                            >
                              {item.name}
                            </button>
                          ) : (
                            <span className="text-slate-800">{item.name}</span>
                          )}
                        </div>
                      </td>

                      <td className="py-2.5 px-4 text-slate-500">{item.size}</td>

                      <td className="py-2.5 px-4">
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[11px] font-semibold">
                          {item.permissions}
                        </span>
                      </td>

                      <td className="py-2.5 px-4 text-slate-400">
                        {item.updated_at ? formatDate(item.updated_at) : "—"}
                      </td>

                      {/* Row Action Buttons */}
                      <td className="py-2.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {editable && (
                            <button
                              type="button"
                              onClick={() => openCodeEditor(item.relativePath)}
                              className="px-2 py-0.5 text-[11px] font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded hover:bg-cyan-100 transition"
                              title="Edit in Code Window"
                            >
                              ✏️ Edit
                            </button>
                          )}

                          {!item.isFolder && (
                            <a
                              href={`/site/${selectedProject?.subdomain}/${item.relativePath}`}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-0.5 text-[11px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded hover:bg-slate-200 transition"
                              title="View / Download"
                            >
                              👁️ View
                            </a>
                          )}

                          {isZip && (
                            <Form method="POST" className="inline">
                              <input type="hidden" name="intent" value="extract_zip" />
                              <input type="hidden" name="project_id" value={selectedProjectId} />
                              <input type="hidden" name="current_path" value={currentPath} />
                              <input type="hidden" name="zip_path" value={item.relativePath} />
                              <button
                                type="submit"
                                disabled={isSubmitting}
                                className="px-2 py-0.5 text-[11px] font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded hover:bg-purple-100 transition"
                                title="Extract ZIP archive in place"
                              >
                                📦 Extract
                              </button>
                            </Form>
                          )}

                          <Form
                            method="POST"
                            className="inline"
                            onSubmit={(e) => {
                              if (
                                !confirm(
                                  `Are you sure you want to permanently delete "${item.name}"?`
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <input type="hidden" name="intent" value="delete_items" />
                            <input type="hidden" name="project_id" value={selectedProjectId} />
                            <input type="hidden" name="current_path" value={currentPath} />
                            <input
                              type="hidden"
                              name="paths"
                              value={JSON.stringify([item.relativePath])}
                            />
                            <button
                              type="submit"
                              disabled={isSubmitting}
                              className="px-2 py-0.5 text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded hover:bg-rose-100 transition"
                              title="Delete file or folder"
                            >
                              🗑️
                            </button>
                          </Form>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 1. CODE EDITOR WINDOW MODAL ("file edit in new window typ") */}
      {editorState.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/75 backdrop-blur-xs">
          <div className="w-full max-w-5xl h-[90vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            {/* Editor Top Bar */}
            <div className="px-4 py-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-3">
                <span className="font-bold text-cyan-400 text-sm">
                  ✏️ {editorState.fileName}
                </span>
                <span className="text-slate-500 hidden sm:inline">
                  {editorState.filePath}
                </span>
                <span className="px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300">
                  {editorState.content !== editorState.originalContent ? "● Unsaved Changes" : "✓ In Sync"}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-[11px] text-slate-400 font-sans hidden md:inline">
                  {editorState.statusMsg}
                </span>

                <button
                  type="button"
                  onClick={saveCodeEditor}
                  disabled={editorState.saving || editorState.loading}
                  className="px-4 py-1.5 font-bold text-white bg-cyan-600 rounded-xl hover:bg-cyan-500 shadow-sm transition disabled:opacity-50"
                >
                  {editorState.saving ? "Saving..." : "💾 Save File"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (
                      editorState.content !== editorState.originalContent &&
                      !confirm("You have unsaved changes in this file. Are you sure you want to close?")
                    ) {
                      return;
                    }
                    setEditorState((prev) => ({ ...prev, isOpen: false }));
                  }}
                  className="p-1 text-slate-400 hover:text-white text-lg leading-none rounded-lg hover:bg-slate-800"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Editor Textarea */}
            <div className="relative flex-1 bg-slate-900 overflow-hidden flex flex-col">
              {editorState.loading ? (
                <div className="flex-1 flex items-center justify-center text-slate-400 font-mono text-sm">
                  Loading code content from cloud storage...
                </div>
              ) : (
                <textarea
                  value={editorState.content}
                  onChange={(e) => setEditorState((prev) => ({ ...prev, content: e.target.value }))}
                  onKeyDown={(e) => {
                    // Handle Tab key indentation
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const target = e.currentTarget;
                      const start = target.selectionStart;
                      const end = target.selectionEnd;
                      target.value = target.value.substring(0, start) + "  " + target.value.substring(end);
                      target.selectionStart = target.selectionEnd = start + 2;
                      setEditorState((prev) => ({ ...prev, content: target.value }));
                    }
                  }}
                  spellCheck={false}
                  className="w-full flex-1 p-4 bg-slate-900 text-slate-100 font-mono text-xs sm:text-sm leading-relaxed resize-none focus:outline-none focus:ring-0 selection:bg-cyan-900"
                  placeholder="Enter code here..."
                />
              )}
            </div>

            {/* Editor Footer */}
            <div className="px-4 py-2 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500 font-mono">
              <div>
                Lines: {editorState.content.split("\n").length} | Chars: {editorState.content.length}
              </div>
              <div className="text-cyan-400 font-sans">
                {editorState.statusMsg || "Ready"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. UPLOAD FILES MODAL (WITH OVERLAP / OVERWRITE SUPPORT) */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">
                Upload & Overwrite Files
              </h3>
              <button
                type="button"
                onClick={() => setShowUploadModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              encType="multipart/form-data"
              onSubmit={() => setShowUploadModal(false)}
              className="p-6 space-y-4"
            >
              <input type="hidden" name="intent" value="upload_files" />
              <input type="hidden" name="project_id" value={selectedProjectId} />
              <input type="hidden" name="current_path" value={currentPath} />

              <div className="p-3 bg-cyan-50/70 border border-cyan-100 rounded-xl text-xs text-cyan-800 space-y-1">
                <div className="font-bold flex items-center gap-1">
                  <span>ℹ️ Upload Target:</span>
                  <code className="bg-cyan-100/80 px-1 py-0.5 rounded font-mono">
                    /{currentPath || "root"}
                  </code>
                </div>
                <p>
                  Files will be uploaded directly to this directory. If a file with the same name already exists, it will be <strong>overwritten (pasted over)</strong> automatically.
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-2">
                  Select Files (HTML, CSS, JS, Images, Media) *
                </label>
                <input
                  type="file"
                  name="uploaded_files"
                  multiple
                  required
                  className="w-full text-sm text-slate-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-cyan-50 file:text-cyan-700 hover:file:bg-cyan-100 border border-slate-200 rounded-xl p-2"
                />
              </div>

              <div className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  id="overwrite_check"
                  defaultChecked
                  disabled
                  className="rounded text-cyan-600"
                />
                <label htmlFor="overwrite_check" className="font-medium">
                  Overlap & overwrite existing files with matching names
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 disabled:opacity-50"
                >
                  {isSubmitting ? "Uploading..." : "Upload & Overwrite"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* 3. CREATE NEW FILE MODAL */}
      {showNewFileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">Create New File</h3>
              <button
                type="button"
                onClick={() => setShowNewFileModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setShowNewFileModal(false)}
              className="p-6 space-y-4"
            >
              <input type="hidden" name="intent" value="create_file" />
              <input type="hidden" name="project_id" value={selectedProjectId} />
              <input type="hidden" name="current_path" value={currentPath} />

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  File Name *
                </label>
                <input
                  type="text"
                  name="file_name"
                  required
                  placeholder="e.g. about.html, style.css, script.js"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Initial Content (Optional)
                </label>
                <textarea
                  name="initial_content"
                  rows={4}
                  placeholder="<!-- Initial code or leave blank -->"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500 font-mono"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowNewFileModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 disabled:opacity-50"
                >
                  Create File
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* 4. CREATE NEW FOLDER MODAL */}
      {showNewFolderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">Create New Folder</h3>
              <button
                type="button"
                onClick={() => setShowNewFolderModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setShowNewFolderModal(false)}
              className="p-6 space-y-4"
            >
              <input type="hidden" name="intent" value="create_folder" />
              <input type="hidden" name="project_id" value={selectedProjectId} />
              <input type="hidden" name="current_path" value={currentPath} />

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Folder Name *
                </label>
                <input
                  type="text"
                  name="folder_name"
                  required
                  placeholder="e.g. assets, images, css, js"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500 font-mono"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowNewFolderModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 disabled:opacity-50"
                >
                  Create Folder
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* 5. DEPLOY FULL ZIP MODAL */}
      {showDeployZipModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">Deploy Full Website ZIP</h3>
              <button
                type="button"
                onClick={() => setShowDeployZipModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              encType="multipart/form-data"
              onSubmit={() => setShowDeployZipModal(false)}
              className="p-6 space-y-4"
            >
              <input type="hidden" name="intent" value="deploy_zip" />
              <input type="hidden" name="project_id" value={selectedProjectId} />

              <p className="text-xs text-slate-500">
                Upload a <code>.zip</code> file containing your complete site (with an <code>index.html</code>). It will unpack and deploy to your cloud webroot.
              </p>

              <div>
                <input
                  type="file"
                  name="zip_file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  required
                  className="w-full text-sm text-slate-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-cyan-50 file:text-cyan-700 hover:file:bg-cyan-100 border border-slate-200 rounded-xl p-2"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowDeployZipModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 disabled:opacity-50"
                >
                  {isSubmitting ? "Deploying..." : "Unpack & Deploy"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* 6. IMAGE PREVIEW MODAL */}
      {previewImage.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-sm font-mono truncate">
                🖼️ {previewImage.fileName}
              </h3>
              <button
                type="button"
                onClick={() => setPreviewImage({ isOpen: false, url: "", fileName: "" })}
                className="text-slate-400 hover:text-slate-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <div className="p-6 flex items-center justify-center bg-slate-900/5 max-h-[70vh] overflow-auto">
              <img
                src={previewImage.url}
                alt={previewImage.fileName}
                className="max-h-[60vh] max-w-full object-contain rounded-lg shadow-sm"
              />
            </div>

            <div className="p-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs">
              <a
                href={previewImage.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-cyan-600 hover:underline"
              >
                Open Full Size in New Tab ↗
              </a>
              <button
                type="button"
                onClick={() => setPreviewImage({ isOpen: false, url: "", fileName: "" })}
                className="px-3 py-1 bg-slate-200 hover:bg-slate-300 rounded-lg font-semibold text-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
