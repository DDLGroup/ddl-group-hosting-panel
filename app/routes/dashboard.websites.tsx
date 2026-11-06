import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { removeNetlifyDomainAlias } from "~/utils/netlify.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";
import {
  deleteAllCloudWebsiteFiles,
  purgeExecutionNodeSite,
  provisionExecutionNodeSite,
  syncFilesToExecutionNode,
} from "~/utils/websiteDeployer.server";

export const meta: MetaFunction = () => {
  return [{ title: "Websites | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  let query = supabaseAdmin
    .from("hosting_projects")
    .select("*, domains(domain_name, ssl_status)")
    .order("created_at", { ascending: false });

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const [websitesRes, serverNodesRes] = await Promise.all([
    query,
    supabaseAdmin.from("server_nodes").select("id, name, ip_address, status"),
  ]);

  return Response.json({
    websites: websitesRes.data || [],
    serverNodes: serverNodesRes.data || [],
    profile,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  if (intent === "create_website") {
    const name = formData.get("name");
    const subdomain = formData.get("subdomain");
    const runtime = formData.get("runtime") || "static";
    const runtimeVersion = formData.get("runtime_version") || "8.2";

    if (
      typeof name !== "string" ||
      typeof subdomain !== "string" ||
      !name.trim() ||
      !subdomain.trim()
    ) {
      return Response.json({ error: "Website name and subdomain are required." }, { status: 400 });
    }

    const cleanSubdomain = subdomain.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");

    // Check if subdomain already exists
    const { data: existing } = await supabaseAdmin
      .from("hosting_projects")
      .select("id")
      .eq("subdomain", cleanSubdomain)
      .maybeSingle();

    if (existing) {
      return Response.json({ error: "That subdomain is already taken. Please choose another." }, { status: 400 });
    }

    // Ensure user has a hosting account record, or create a default one
    let hostingAccountId = "";
    const { data: account } = await supabaseAdmin
      .from("hosting_accounts")
      .select("id")
      .eq("customer_id", profile.id)
      .maybeSingle();

    if (account) {
      hostingAccountId = account.id;
    } else {
      // Find or create default plan
      let planId = "";
      const { data: plan } = await supabaseAdmin
        .from("hosting_plans")
        .select("id")
        .limit(1)
        .maybeSingle();

      if (plan) {
        planId = plan.id;
      } else {
        const { data: newPlan } = await supabaseAdmin
          .from("hosting_plans")
          .insert({
            name: "Starter Cloud",
            slug: "starter-cloud",
            max_websites: 5,
            max_storage_mb: 2048,
            price_cents: 999,
          })
          .select("id")
          .single();
        planId = newPlan?.id || "";
      }

      if (planId) {
        const { data: newAccount } = await supabaseAdmin
          .from("hosting_accounts")
          .insert({
            customer_id: profile.id,
            plan_id: planId,
            status: "active",
          })
          .select("id")
          .single();
        hostingAccountId = newAccount?.id || "";
      }
    }

    // Auto-resolve active server node (ServerByte)
    let serverNodeId = (formData.get("server_node_id") as string | null) || null;
    if (!serverNodeId) {
      const { data: activeNode } = await supabaseAdmin
        .from("server_nodes")
        .select("id")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (activeNode) {
        serverNodeId = activeNode.id;
      }
    }

    // Create hosting project
    const { data: project, error: createError } = await supabaseAdmin
      .from("hosting_projects")
      .insert({
        hosting_account_id: hostingAccountId || null,
        customer_id: profile.id,
        name: name.trim(),
        subdomain: cleanSubdomain,
        runtime: runtime as string,
        runtime_version: runtimeVersion as string,
        server_node_id: serverNodeId || null,
        status: "active",
      })
      .select()
      .single();

    if (createError) {
      return Response.json({ error: createError.message }, { status: 500 });
    }

    // Auto-provision on ServerByte & initialize starter index.html
    if (project) {
      // 1. Provision folder on ServerByte
      await provisionExecutionNodeSite(cleanSubdomain, serverNodeId);

      // 2. Generate initial modern starter index.html
      const starterHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name.trim()} - DDL Group Hosting</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #090d16 0%, #0f172a 100%);
      color: #f8fafc;
      padding: 1.5rem;
    }
    .card {
      background: rgba(30, 41, 59, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 1.25rem;
      padding: 3rem 2.5rem;
      max-width: 540px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.85rem;
      background: rgba(6, 182, 212, 0.15);
      border: 1px solid rgba(6, 182, 212, 0.3);
      color: #22d3ee;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      background: #22d3ee;
      border-radius: 50%;
      box-shadow: 0 0 10px #22d3ee;
    }
    h1 {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      margin-bottom: 0.75rem;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: #94a3b8;
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 1.5rem;
    }
    .url-pill {
      display: inline-block;
      padding: 0.5rem 1rem;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      color: #38bdf8;
      font-family: monospace;
      font-size: 0.9rem;
      word-break: break-all;
      margin-bottom: 1.5rem;
    }
    .footer {
      font-size: 0.8rem;
      color: #64748b;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 1.25rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">
      <span class="badge-dot"></span>
      <span>DDL Group Hosting Active</span>
    </div>
    <h1>${name.trim()}</h1>
    <div class="url-pill">https://${cleanSubdomain}.ddlgroup.host</div>
    <p>Your website environment has been automatically generated on the ServerByte production node. Upload your HTML, PHP, or ZIP archive in the File Manager to make your site live!</p>
    <div class="footer">
      Powered by DDL Group Hosting Panel &bull; High Performance Cloud
    </div>
  </div>
</body>
</html>`;

      const starterBuffer = Buffer.from(starterHtml, "utf-8");

      // Save to Supabase Storage
      await supabaseAdmin.storage
        .from("client-websites")
        .upload(`${cleanSubdomain}/index.html`, starterBuffer, {
          contentType: "text/html; charset=utf-8",
          upsert: true,
        });

      // Sync starter file to execution node (ServerByte)
      await syncFilesToExecutionNode(cleanSubdomain, [
        { path: "index.html", buffer: starterBuffer },
      ]);

      await supabaseAdmin.from("deployments").insert({
        project_id: project.id,
        version_number: 1,
        runtime: runtime as string,
        source_type: "manual",
        status: "deployed",
        commit_message: "Auto-provisioned environment and initial starter template",
        deployed_by: profile.id,
      });
    }

    return Response.json({ success: "Website successfully provisioned and synchronized with ServerByte!" });
  }

  if (intent === "delete_website") {
    const projectId = formData.get("project_id");
    if (typeof projectId !== "string" || !projectId) {
      return Response.json({ error: "Project ID is required." }, { status: 400 });
    }

    // 1. Fetch project details to verify existence and check permissions
    let projectQuery = supabaseAdmin
      .from("hosting_projects")
      .select("id, name, subdomain, server_node_id, customer_id")
      .eq("id", projectId);

    if (profile.role === "customer") {
      projectQuery = projectQuery.eq("customer_id", profile.id);
    }

    const { data: project, error: fetchErr } = await projectQuery.maybeSingle();

    if (fetchErr || !project) {
      return Response.json({ error: "Website project not found or access denied." }, { status: 404 });
    }

    // 2. Fetch and remove all connected custom domains from Netlify edge router
    const { data: connectedDomains } = await supabaseAdmin
      .from("domains")
      .select("domain_name")
      .eq("project_id", project.id);

    if (connectedDomains && connectedDomains.length > 0) {
      for (const d of connectedDomains) {
        try {
          await removeNetlifyDomainAlias(d.domain_name);
        } catch (netlifyErr) {
          console.warn(`[Delete Website] Failed to remove Netlify alias for ${d.domain_name}:`, netlifyErr);
        }
      }
    }

    // 3. Delete all associated databases
    await supabaseAdmin
      .from("databases")
      .delete()
      .eq("project_id", project.id);

    // 4. Delete all associated backups
    await supabaseAdmin
      .from("backups")
      .delete()
      .eq("project_id", project.id);

    // 5. Delete all associated deployments
    await supabaseAdmin
      .from("deployments")
      .delete()
      .eq("project_id", project.id);

    // 6. Delete all storage files in Supabase Storage AND execution node (ServerByte)
    await Promise.all([
      deleteAllCloudWebsiteFiles(project.subdomain),
      purgeExecutionNodeSite(project.subdomain, project.server_node_id),
    ]);

    // 7. Delete the project record from hosting_projects (domains cascade delete if any remain)
    const { error: deleteErr } = await supabaseAdmin
      .from("hosting_projects")
      .delete()
      .eq("id", project.id);

    if (deleteErr) {
      return Response.json({ error: deleteErr.message }, { status: 500 });
    }

    return Response.json({
      success: `Website "${project.name}" and all associated files, storage, domains, and databases were permanently deleted.`,
    });
  }

  if (intent === "update_website") {
    const projectId = formData.get("project_id");
    const name = formData.get("name");
    const subdomain = formData.get("subdomain");
    const runtime = formData.get("runtime") || "static";
    const runtimeVersion = formData.get("runtime_version") || "8.2";
    const status = formData.get("status") || "active";
    const serverNodeId = formData.get("server_node_id");

    if (typeof projectId !== "string" || !projectId) {
      return Response.json({ error: "Project ID is required." }, { status: 400 });
    }

    if (typeof name !== "string" || !name.trim()) {
      return Response.json({ error: "Website name cannot be empty." }, { status: 400 });
    }

    let query = supabaseAdmin
      .from("hosting_projects")
      .select("id, subdomain, customer_id")
      .eq("id", projectId);

    if (profile.role === "customer") {
      query = query.eq("customer_id", profile.id);
    }

    const { data: project, error: fetchErr } = await query.maybeSingle();
    if (fetchErr || !project) {
      return Response.json({ error: "Website not found or access denied." }, { status: 404 });
    }

    let cleanSubdomain = project.subdomain;
    if (typeof subdomain === "string" && subdomain.trim()) {
      const sanitized = subdomain.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (sanitized && sanitized !== project.subdomain) {
        const { data: existingSub } = await supabaseAdmin
          .from("hosting_projects")
          .select("id")
          .eq("subdomain", sanitized)
          .neq("id", project.id)
          .maybeSingle();

        if (existingSub) {
          return Response.json({ error: `Subdomain "${sanitized}" is already taken.` }, { status: 400 });
        }
        cleanSubdomain = sanitized;
      }
    }

    const { error: updateErr } = await supabaseAdmin
      .from("hosting_projects")
      .update({
        name: name.trim(),
        subdomain: cleanSubdomain,
        runtime: runtime as string,
        runtime_version: runtimeVersion as string,
        status: status as string,
        server_node_id: serverNodeId ? (serverNodeId as string) : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", project.id);

    if (updateErr) {
      return Response.json({ error: updateErr.message }, { status: 500 });
    }

    return Response.json({
      success: `Website "${name.trim()}" configuration updated successfully!`,
    });
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function Websites() {
  const { websites, serverNodes } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<any>(null);
  const isSubmitting = navigation.state === "submitting";

  const runtimeBadges: Record<string, { label: string; color: string }> = {
    static: { label: "HTML/Static", color: "bg-orange-100 text-orange-800 border-orange-200" },
    php: { label: "PHP 8.2", color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
    python: { label: "Python 3.12", color: "bg-blue-100 text-blue-800 border-blue-200" },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Hosted Websites
          </h1>
          <p className="text-sm text-slate-500">
            Manage your isolated web applications, domains, and deployments
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
        >
          + Deploy New Website
        </button>
      </div>

      {actionData?.error && (
        <div className="p-4 text-sm font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-xl">
          {actionData.error}
        </div>
      )}

      {actionData?.success && (
        <div className="p-4 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl">
          {actionData.success}
        </div>
      )}

      {websites.length === 0 ? (
        <div className="p-12 text-center bg-white border border-slate-200 shadow-xs rounded-2xl">
          <div className="inline-flex items-center justify-center w-14 h-14 mb-4 rounded-full bg-cyan-50 text-cyan-600">
            <svg
              width="32"
              height="32"
              style={{ width: "32px", height: "32px" }}
              className="w-8 h-8"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-slate-800">No websites created yet</h2>
          <p className="mt-1 text-sm text-slate-500 max-w-sm mx-auto">
            Provision your first web application on an isolated execution node with HTML, PHP, or Python runtime.
          </p>
          <button
            onClick={() => setIsModalOpen(true)}
            className="mt-5 px-4 py-2 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700"
          >
            Create Website
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {websites.map((site: any) => {
            const badge = runtimeBadges[site.runtime] || runtimeBadges.static;
            return (
              <div
                key={site.id}
                className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs flex flex-col justify-between hover:border-slate-300 transition"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <h3 className="font-bold text-slate-900 text-base">{site.name}</h3>
                    <span className="inline-block px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800">
                      {site.status}
                    </span>
                  </div>

                  <p className="text-xs text-slate-500 font-mono mb-4 truncate">
                    https://{site.subdomain}.ddlgroup.host
                  </p>

                  <div className="flex items-center gap-2 mb-4">
                    <span className={`px-2 py-0.5 text-xs font-semibold rounded-md border ${badge.color}`}>
                      {badge.label}
                    </span>
                    <span className="text-xs text-slate-400">
                      Added {formatDate(site.created_at)}
                    </span>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                  <a
                    href={`/site/${site.subdomain}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-bold text-cyan-600 hover:text-cyan-700 flex items-center gap-1"
                  >
                    <span>Visit Live Site</span>
                    <span>↗</span>
                  </a>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditingSite(site)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                      title={`Edit configuration for ${site.name}`}
                    >
                      <svg
                        width="14"
                        height="14"
                        style={{ width: "14px", height: "14px" }}
                        className="w-3.5 h-3.5 text-slate-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      <span>Edit</span>
                    </button>
                    <a
                      href={`/dashboard/files?project=${site.id}`}
                      className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
                    >
                      Upload Files
                    </a>
                    <Form
                      method="POST"
                      onSubmit={(e) => {
                        if (
                          !confirm(
                            `Are you sure you want to permanently delete "${site.name}"?\n\nThis will permanently delete:\n• All website files & storage (${site.subdomain}.ddlgroup.host)\n• All connected custom domains & SSL\n• All associated databases & deployments\n\nThis action cannot be undone.`
                          )
                        ) {
                          e.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="intent" value="delete_website" />
                      <input type="hidden" name="project_id" value={site.id} />
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 hover:text-rose-900 transition"
                        title={`Delete website "${site.name}"`}
                      >
                        <svg
                          width="14"
                          height="14"
                          style={{ width: "14px", height: "14px" }}
                          className="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        <span>Delete</span>
                      </button>
                    </Form>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Provision Website Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Provision New Website</h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setIsModalOpen(false)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="create_website" />

              <TextField
                id="name"
                name="name"
                label="Website Project Name"
                type="text"
                required
                placeholder="My Business Website"
              />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Subdomain Name
                </label>
                <div className="flex items-center">
                  <input
                    id="subdomain"
                    name="subdomain"
                    type="text"
                    required
                    placeholder="my-business"
                    className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-l-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <span className="px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-100 border border-l-0 border-slate-200 rounded-r-lg">
                    .ddlgroup.host
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Execution Runtime
                </label>
                <select
                  name="runtime"
                  defaultValue="static"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="static">Static (HTML / CSS / JavaScript / React SPA)</option>
                  <option value="php">PHP 8.2 (FastCGI, WordPress, Laravel)</option>
                  <option value="python">Python 3.12 (WSGI, Flask, Django, FastAPI)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Hosting Execution Node
                </label>
                <select
                  name="server_node_id"
                  defaultValue={serverNodes.find((n: any) => n.status === "active")?.id || ""}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  {serverNodes.map((node: any) => (
                    <option key={node.id} value={node.id}>
                      {node.name} ({node.ip_address}) — {node.status === "active" ? "Active (ServerByte)" : node.status}
                    </option>
                  ))}
                  {serverNodes.length === 0 && (
                    <option value="">DDL Cloud Edge (Serverless)</option>
                  )}
                </select>
              </div>

              <div className="p-3 text-xs text-slate-600 bg-cyan-50/70 border border-cyan-100 rounded-xl space-y-1">
                <p className="font-semibold text-cyan-800">⚡ Automated ServerByte Sync:</p>
                <p>Creating this website will immediately generate isolated folder <code>sites/[subdomain]/</code> and live starter assets on ServerByte with zero manual steps.</p>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setIsModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Provision Website
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Edit Website Modal */}
      {editingSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-cyan-50 text-cyan-600 rounded-lg">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Edit Website Settings</h2>
                  <p className="text-xs text-slate-500">Configure parameters for {editingSite.name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingSite(null)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1 rounded-lg hover:bg-slate-100"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setEditingSite(null)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="update_website" />
              <input type="hidden" name="project_id" value={editingSite.id} />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Website Project Name
                </label>
                <input
                  type="text"
                  name="name"
                  defaultValue={editingSite.name}
                  required
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Subdomain Slug
                </label>
                <div className="flex items-center">
                  <input
                    type="text"
                    name="subdomain"
                    defaultValue={editingSite.subdomain}
                    required
                    className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-l-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <span className="px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-100 border border-l-0 border-slate-200 rounded-r-lg">
                    .ddlgroup.host
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Default site URL: https://{editingSite.subdomain}.ddlgroup.host
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Runtime Stack
                  </label>
                  <select
                    name="runtime"
                    defaultValue={editingSite.runtime || "static"}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  >
                    <option value="static">Static (HTML/CSS/JS)</option>
                    <option value="php">PHP Engine</option>
                    <option value="python">Python Engine</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Version
                  </label>
                  <select
                    name="runtime_version"
                    defaultValue={editingSite.runtime_version || "8.2"}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  >
                    <option value="8.2">8.2 (Recommended)</option>
                    <option value="8.3">8.3 (Latest)</option>
                    <option value="8.1">8.1 (LTS)</option>
                    <option value="7.4">7.4 (Legacy)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Execution Node / Host
                  </label>
                  <select
                    name="server_node_id"
                    defaultValue={editingSite.server_node_id || ""}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  >
                    <option value="">⚡ Serverless Edge (Default)</option>
                    {serverNodes && serverNodes.map((node: any) => (
                      <option key={node.id} value={node.id}>
                        🖥️ {node.name} ({node.ip_address})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Website Status
                  </label>
                  <select
                    name="status"
                    defaultValue={editingSite.status || "active"}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  >
                    <option value="active">🟢 Active</option>
                    <option value="suspended">🟡 Suspended / Maintenance</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setEditingSite(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Save Changes
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
