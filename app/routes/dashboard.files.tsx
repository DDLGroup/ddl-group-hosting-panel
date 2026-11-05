import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import {
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import Button from "~/components/Button";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";
import { deployZipToCloudStorage } from "~/utils/websiteDeployer.server";

export const meta: MetaFunction = () => {
  return [{ title: "File Manager | DDL Group Hosting Panel" }];
};

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

  // List real files from Supabase Storage for this website
  let files: Array<{ name: string; size: string; updated_at?: string }> = [];

  if (selectedProject?.subdomain) {
    const { data: storageList } = await supabaseAdmin.storage
      .from("client-websites")
      .list(selectedProject.subdomain, { limit: 100 });

    if (storageList) {
      files = storageList.map((item) => ({
        name: item.name,
        size: item.metadata?.size ? `${(item.metadata.size / 1024).toFixed(1)} KB` : "—",
        updated_at: item.updated_at,
      }));
    }
  }

  return Response.json({
    projects: projects || [],
    selectedProjectId,
    selectedProject,
    files,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  const uploadHandler = unstable_createMemoryUploadHandler({
    maxPartSize: 50 * 1024 * 1024, // 50MB
  });

  const formData = await unstable_parseMultipartFormData(request, uploadHandler);
  const projectId = formData.get("project_id") as string;
  const file = formData.get("zip_file") as File | null;

  if (!projectId) {
    return Response.json({ error: "Please select a target website." }, { status: 400 });
  }

  if (!file || !(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Please select a valid .ZIP website archive to upload." }, { status: 400 });
  }

  const { data: project } = await supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain, runtime")
    .eq("id", projectId)
    .single();

  if (!project) {
    return Response.json({ error: "Target website project not found." }, { status: 404 });
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Unpack ZIP and deploy all files directly into Supabase Cloud Storage
    const result = await deployZipToCloudStorage(project.subdomain, buffer);

    // Record deployment in database
    await supabaseAdmin.from("deployments").insert({
      project_id: project.id,
      version_number: 1,
      runtime: project.runtime || "static",
      source_type: "zip_upload",
      status: "deployed",
      commit_message: `Uploaded ZIP: ${file.name} (${result.uploadedCount} files deployed)`,
      deployed_by: profile.id,
      logs: `Extracted and deployed ${result.uploadedCount} files to cloud storage for ${project.subdomain}.`,
    });

    return Response.json({
      success: `Successfully deployed ${result.uploadedCount} files! Your website is now live.`,
      liveUrl: `/site/${project.subdomain}`,
      subdomain: project.subdomain,
    });
  } catch (err: any) {
    console.error("ZIP deployment error:", err);
    return Response.json({ error: err.message || "Failed to process ZIP archive." }, { status: 500 });
  }
}

export default function FileManager() {
  const { projects, selectedProjectId, selectedProject, files } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string; liveUrl?: string; subdomain?: string }>();
  const navigation = useNavigation();
  const [, setSearchParams] = useSearchParams();

  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Cloud File Manager & Deployer
          </h1>
          <p className="text-sm text-slate-500">
            Deploy ZIP website bundles directly to cloud storage and inspect active web assets
          </p>
        </div>

        {projects.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-500">Active Website:</label>
            <select
              value={selectedProjectId}
              onChange={(e) => {
                setSearchParams({ project: e.target.value });
              }}
              className="px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.subdomain})
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
        <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-bold text-emerald-900">🚀 {actionData.success}</div>
            <p className="text-xs text-emerald-700">
              Your website is published globally on Netlify and Supabase Cloud Storage.
            </p>
          </div>
          {actionData.liveUrl && (
            <a
              href={actionData.liveUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition"
            >
              Open Live Website ↗
            </a>
          )}
        </div>
      )}

      {/* ZIP Upload Card */}
      <div className="p-6 bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Upload & Deploy Website ZIP Archive
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Select a <code>.zip</code> file from your computer containing your HTML, CSS, JavaScript, and images (with an <code>index.html</code>). It will be extracted and published instantly.
            </p>
          </div>

          {selectedProject && (
            <a
              href={`/site/${selectedProject.subdomain}`}
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
            >
              <span>Visit Live: /site/{selectedProject.subdomain}</span>
              <span>↗</span>
            </a>
          )}
        </div>

        <Form method="POST" encType="multipart/form-data" className="space-y-4">
          <input type="hidden" name="project_id" value={selectedProjectId} />

          <div className="flex flex-col sm:flex-row items-center gap-4">
            <input
              type="file"
              name="zip_file"
              accept=".zip,application/zip,application/x-zip-compressed"
              required
              className="w-full sm:flex-1 text-sm text-slate-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-cyan-50 file:text-cyan-700 hover:file:bg-cyan-100 border border-slate-200 rounded-xl p-1"
            />

            <Button
              type="submit"
              loading={isSubmitting}
              disabled={!selectedProjectId}
              className="w-full sm:w-auto px-6 font-semibold text-white bg-cyan-600 hover:bg-cyan-700 rounded-xl"
            >
              Upload & Publish Live
            </Button>
          </div>
        </Form>
      </div>

      {/* Files List Table */}
      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600 font-mono">
          <span>Active Webroot: client-websites/{selectedProject?.subdomain || "default"}/</span>
          <span className="font-semibold text-slate-700">{files.length} Files Deployed</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-white text-slate-400 font-semibold text-xs uppercase border-b border-slate-100">
              <tr>
                <th className="py-3 px-4">File Name</th>
                <th className="py-3 px-4">Size</th>
                <th className="py-3 px-4">Last Updated</th>
                <th className="py-3 px-4 text-right">Direct Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {files.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-slate-400">
                    No files uploaded yet for this website. Upload a ZIP file above to publish your code!
                  </td>
                </tr>
              ) : (
                files.map((f: any) => (
                  <tr key={f.name} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900">
                      📄 {f.name}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-500">{f.size}</td>
                    <td className="py-3 px-4 text-xs text-slate-400">
                      {f.updated_at ? formatDate(f.updated_at) : "—"}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {selectedProject && (
                        <a
                          href={`/site/${selectedProject.subdomain}/${f.name}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-semibold text-cyan-600 hover:text-cyan-700"
                        >
                          View ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
