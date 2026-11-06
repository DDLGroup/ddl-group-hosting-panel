import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireUserProfile } from "~/utils/auth.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";
import { getMimeType, syncFilesToExecutionNode } from "~/utils/websiteDeployer.server";

function sanitizePath(rawPath: string): string {
  // Remove leading/trailing slashes, disallow path traversal ../
  return rawPath
    .replace(/^(\/|\\)+/, "")
    .replace(/(\/|\\)+$/, "")
    .split(/[\/\\]/)
    .filter((segment) => segment && segment !== ".." && segment !== ".")
    .join("/");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project");
  const rawPath = url.searchParams.get("path") || "";

  if (!projectId || !rawPath) {
    return Response.json({ error: "Missing project ID or file path." }, { status: 400 });
  }

  const cleanPath = sanitizePath(rawPath);
  const supabaseAdmin = getSupabaseAdminClient();

  // Verify project ownership
  let query = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain, customer_id")
    .eq("id", projectId);

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const { data: project, error: projErr } = await query.maybeSingle();

  if (projErr || !project) {
    return Response.json({ error: "Project not found or access denied." }, { status: 404 });
  }

  const storageKey = `${project.subdomain}/${cleanPath}`;
  const { data: fileBlob, error: downloadErr } = await supabaseAdmin.storage
    .from("client-websites")
    .download(storageKey);

  if (downloadErr || !fileBlob) {
    return Response.json({ error: "Failed to download file or file does not exist." }, { status: 404 });
  }

  const text = await fileBlob.text();
  return Response.json({
    content: text,
    path: cleanPath,
    size: fileBlob.size,
    mimeType: getMimeType(cleanPath),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();

  const projectId = String(formData.get("project_id") || "");
  const rawPath = String(formData.get("path") || "");
  const content = String(formData.get("content") || "");

  if (!projectId || !rawPath) {
    return Response.json({ error: "Missing project ID or file path." }, { status: 400 });
  }

  const cleanPath = sanitizePath(rawPath);
  const supabaseAdmin = getSupabaseAdminClient();

  // Verify project ownership
  let query = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain, customer_id")
    .eq("id", projectId);

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const { data: project, error: projErr } = await query.maybeSingle();

  if (projErr || !project) {
    return Response.json({ error: "Project not found or access denied." }, { status: 404 });
  }

  const storageKey = `${project.subdomain}/${cleanPath}`;
  const mimeType = getMimeType(cleanPath);
  const buffer = Buffer.from(content, "utf-8");

  const { error: uploadErr } = await supabaseAdmin.storage
    .from("client-websites")
    .upload(storageKey, buffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (uploadErr) {
    return Response.json({ error: uploadErr.message }, { status: 500 });
  }

  // Auto-sync to connected execution node (e.g. ServerByte)
  await syncFilesToExecutionNode(project.subdomain, [{ path: cleanPath, buffer }]);

  return Response.json({
    success: true,
    message: `File "${cleanPath}" saved successfully!`,
    path: cleanPath,
  });
}
