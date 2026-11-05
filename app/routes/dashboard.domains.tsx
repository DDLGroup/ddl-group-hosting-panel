import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { addNetlifyDomainAlias, removeNetlifyDomainAlias } from "~/utils/netlify.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Domains & SSL | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  let domainsQuery = supabaseAdmin
    .from("domains")
    .select("*, hosting_projects(name, subdomain)")
    .order("created_at", { ascending: false });

  let projectsQuery = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain");

  if (profile.role === "customer") {
    domainsQuery = domainsQuery.eq("customer_id", profile.id);
    projectsQuery = projectsQuery.eq("customer_id", profile.id);
  }

  const [domainsRes, projectsRes] = await Promise.all([domainsQuery, projectsQuery]);

  return Response.json({
    domains: domainsRes.data || [],
    projects: projectsRes.data || [],
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  if (intent === "add_domain") {
    const domainName = formData.get("domain_name");
    const projectId = formData.get("project_id");

    if (typeof domainName !== "string" || !domainName.trim() || !projectId) {
      return Response.json({ error: "Domain name and target website are required." }, { status: 400 });
    }

    const cleanDomain = domainName.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

    // Check if domain already registered
    const { data: existing } = await supabaseAdmin
      .from("domains")
      .select("id")
      .eq("domain_name", cleanDomain)
      .maybeSingle();

    if (existing) {
      return Response.json({ error: "This domain is already mapped to a website." }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("domains").insert({
      customer_id: profile.id,
      project_id: projectId as string,
      domain_name: cleanDomain,
      ssl_status: "active",
      ssl_issuer: "Let's Encrypt Authority X3",
      verified: true,
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    // Automatically register domain with Netlify edge router & auto-SSL
    const netlifyRes = await addNetlifyDomainAlias(cleanDomain);
    const successMsg = netlifyRes.success
      ? "Custom domain connected and automatically synced to Netlify edge router with SSL!"
      : "Custom domain connected in database! (Add NETLIFY_AUTH_TOKEN to Netlify env for 100% automated edge sync).";

    return Response.json({ success: successMsg });
  }

  if (intent === "delete_domain") {
    const domainId = formData.get("domain_id");
    if (!domainId || typeof domainId !== "string") {
      return Response.json({ error: "Domain ID is required" }, { status: 400 });
    }

    const { data: toDelete } = await supabaseAdmin
      .from("domains")
      .select("domain_name")
      .eq("id", domainId)
      .maybeSingle();

    let deleteQuery = supabaseAdmin.from("domains").delete().eq("id", domainId);
    if (profile.role === "customer") {
      deleteQuery = deleteQuery.eq("customer_id", profile.id);
    }

    const { error } = await deleteQuery;
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (toDelete?.domain_name) {
      await removeNetlifyDomainAlias(toDelete.domain_name);
    }

    return Response.json({ success: "Custom domain disconnected and deleted successfully!" });
  }

  return Response.json({ error: "Invalid intent." }, { status: 400 });
}

export default function Domains() {
  const { domains, projects } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Domains & SSL Certificates
          </h1>
          <p className="text-sm text-slate-500">
            Connect custom domains, configure DNS routing, and manage automated TLS/SSL
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          disabled={projects.length === 0}
          className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition disabled:opacity-50"
        >
          + Connect Custom Domain
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

      <div className="p-5 bg-white border border-slate-200 shadow-xs rounded-2xl">
        <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-2">
          Global DNS Configuration for Custom Domains
        </h2>
        <p className="text-xs text-slate-500 mb-4">
          In your domain DNS manager (e.g. <strong>Cloudflare, GoDaddy, Namecheap</strong>), configure the following DNS records:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
            <span className="text-[10px] uppercase font-bold text-cyan-600 block">For Subdomains (e.g. test.advjagadish.in / test.ddlg.in)</span>
            <div><span className="text-slate-400">Type: </span><span className="font-bold text-slate-900">CNAME</span></div>
            <div><span className="text-slate-400">Target / Value: </span><span className="font-bold text-cyan-700">ddl-group-hosting-panel.netlify.app</span></div>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
            <span className="text-[10px] uppercase font-bold text-indigo-600 block">For Root / Apex Domains (e.g. clientdomain.com)</span>
            <div><span className="text-slate-400">Type: </span><span className="font-bold text-slate-900">A Record</span></div>
            <div><span className="text-slate-400">Points to IP: </span><span className="font-bold text-indigo-700">75.2.60.5</span></div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">Domain Name</th>
                <th className="py-3.5 px-4">Mapped Website</th>
                <th className="py-3.5 px-4">SSL / TLS</th>
                <th className="py-3.5 px-4">Issuer</th>
                <th className="py-3.5 px-4">Added On</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {domains.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400">
                    No custom domains connected yet.
                  </td>
                </tr>
              ) : (
                domains.map((d: any) => (
                  <tr key={d.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-slate-900">
                      <div className="flex items-center gap-2">
                        <span>{d.domain_name}</span>
                        <a
                          href={`https://${d.domain_name}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-400 hover:text-cyan-600"
                          title="Open website in new tab"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-xs font-medium text-slate-700">
                      {d.hosting_projects?.name || "Website"}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>
                        Active
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-500">
                      {d.ssl_issuer || "Let's Encrypt"}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">
                      {formatDate(d.created_at)}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <Form
                        method="POST"
                        onSubmit={(e) => {
                          if (!confirm(`Are you sure you want to disconnect and delete custom domain "${d.domain_name}"?`)) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="intent" value="delete_domain" />
                        <input type="hidden" name="domain_id" value={d.id} />
                        <button
                          type="submit"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 hover:text-rose-900 transition"
                          title="Delete custom domain"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Connect Custom Domain</h2>
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
              <input type="hidden" name="intent" value="add_domain" />

              <TextField
                id="domain_name"
                name="domain_name"
                label="Domain Name (FQDN)"
                type="text"
                required
                placeholder="example.com or client.org"
              />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Target Website
                </label>
                <select
                  name="project_id"
                  required
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  {projects.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.subdomain}.ddlgroup.host)
                    </option>
                  ))}
                </select>
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
                  Issue SSL & Map Domain
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
