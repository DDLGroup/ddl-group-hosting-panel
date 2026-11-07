import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireUserProfile } from "~/utils/auth.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project_id");
  const filename = url.searchParams.get("filename") || "upload.zip";
  const type = url.searchParams.get("type") || "deploy_zip";
  const currentPath = (url.searchParams.get("current_path") || "").replace(/^\/+|\/+$/g, "");

  if (!projectId) {
    return Response.json({ error: "Missing project_id parameter." }, { status: 400 });
  }

  const supabaseAdmin = getSupabaseAdminClient();

  // Verify access to project
  let projectQuery = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain, runtime, server_node_id, customer_id")
    .eq("id", projectId);

  if (profile.role === "customer") {
    projectQuery = projectQuery.eq("customer_id", profile.id);
  }

  const { data: project, error: projErr } = await projectQuery.maybeSingle();

  if (projErr || !project) {
    return Response.json({ error: "Website project not found or access denied." }, { status: 404 });
  }

  const cleanFileName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  let storagePath = "";

  if (type === "deploy_zip") {
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    storagePath = `_temp_zips/${project.subdomain}_${Date.now()}_${randomSuffix}.zip`;
  } else {
    const targetPrefix = currentPath ? `${currentPath}/`.replace(/\/+$/, "/") : "";
    storagePath = `${project.subdomain}/${targetPrefix}${cleanFileName}`;
  }

  const { data, error } = await supabaseAdmin.storage
    .from("client-websites")
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (error || !data) {
    return Response.json(
      { error: error?.message || "Failed to create signed upload URL." },
      { status: 500 }
    );
  }

  return Response.json({
    success: true,
    signedUrl: data.signedUrl,
    storagePath,
    token: data.token,
    cleanFileName,
    subdomain: project.subdomain,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return loader({ request, params: {}, context: {} });
}
