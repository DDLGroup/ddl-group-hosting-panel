import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { removeNetlifyDomainAlias } from "~/utils/netlify.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";
import { deleteAllCloudWebsiteFiles } from "~/utils/websiteDeployer.server";

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

  const { data: websites } = await query;

  return Response.json({ websites: websites || [], profile });
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
        status: "active",
      })
      .select()
      .single();

    if (createError) {
      return Response.json({ error: createError.message }, { status: 500 });
    }

    // Record initial deployment log
    if (project) {
      await supabaseAdmin.from("deployments").insert({
        project_id: project.id,
        version_number: 1,
        runtime: runtime as string,
        source_type: "manual",
        status: "deployed",
        commit_message: "Initial project scaffold provisioned",
        deployed_by: profile.id,
      });
    }

    return Response.json({ success: "Website successfully provisioned!" });
  }

  if (intent === "delete_website") {
    const projectId = formData.get("project_id");
    if (typeof projectId !== "string" || !projectId) {
      return Response.json({ error: "Project ID is required." }, { status: 400 });
    }

    // 1. Fetch project details to verify existence and check permissions
    let projectQuery = supabaseAdmin
      .from("hosting_projects")
      .select("id, name, subdomain, customer_id")
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

    // 6. Delete all storage files in Supabase Storage under client-websites/{subdomain}
    await deleteAllCloudWebsiteFiles(project.subdomain);

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

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function Websites() {
  const { websites } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [isModalOpen, setIsModalOpen] = useState(false);
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
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                  <div className="flex items-center gap-2">
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
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

              <div className="p-3 text-xs text-slate-500 bg-cyan-50/60 border border-cyan-100 rounded-xl">
                ℹ️ After provisioning, you can upload a ZIP archive of your website files in the File Manager or connect your custom domain with automatic SSL.
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
    </div>
  );
}
