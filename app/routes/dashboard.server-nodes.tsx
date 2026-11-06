import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { requireRole } from "~/utils/auth.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Server Nodes & Web Hosting | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requireRole(request, ["super_admin", "technical_staff"]);
  const supabaseAdmin = getSupabaseAdminClient();

  const { data: nodes } = await supabaseAdmin
    .from("server_nodes")
    .select("*")
    .order("created_at", { ascending: false });

  return Response.json({ nodes: nodes || [] });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireRole(request, ["super_admin", "technical_staff"]);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  if (intent === "create_node") {
    const name = String(formData.get("name") || "").trim();
    const hostname = String(formData.get("hostname") || "").trim();
    const ip_address = String(formData.get("ip_address") || "").trim();
    const region = String(formData.get("region") || "ap-south-1").trim();
    const provider_type = String(formData.get("provider_type") || "cpanel").trim();
    const ftp_host = String(formData.get("ftp_host") || "").trim();
    const ftp_user = String(formData.get("ftp_user") || "").trim();

    if (!name || !hostname || !ip_address) {
      return Response.json({ error: "Name, Hostname, and Server IP Address are required." }, { status: 400 });
    }

    const capabilities = {
      provider: provider_type,
      php: true,
      php_versions: ["7.4", "8.0", "8.1", "8.2", "8.3"],
      mysql: true,
      ftp_host: ftp_host || hostname,
      ftp_user: ftp_user || undefined,
    };

    const { error } = await supabaseAdmin.from("server_nodes").insert({
      name,
      hostname,
      ip_address,
      region,
      capabilities,
      status: "active",
      current_load: 12,
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: "Server node connected successfully!" });
  }

  if (intent === "delete_node") {
    const nodeId = String(formData.get("node_id") || "");
    if (!nodeId) {
      return Response.json({ error: "Node ID is required" }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("server_nodes").delete().eq("id", nodeId);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: "Server node removed." });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}

export default function ServerNodes() {
  const { nodes } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [showAddModal, setShowAddModal] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Execution Nodes & Hosting Backends
          </h1>
          <p className="text-sm text-slate-500">
            Connect and manage execution environments: Existing Web Hosting (ServerByte / cPanel), Cloud Nodes, and VPS
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Connect Web Hosting / Node
        </button>
      </div>

      {actionData?.error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          {actionData.error}
        </div>
      )}

      {actionData?.success && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-xl">
          {actionData.success}
        </div>
      )}

      {/* Guide Card for Existing Web Hosting */}
      <div className="p-5 bg-gradient-to-r from-cyan-900 to-slate-900 text-white rounded-2xl shadow-md border border-cyan-800">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-cyan-500/20 rounded-xl text-cyan-300">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          </div>
          <div className="space-y-1 grow">
            <h3 className="font-bold text-base text-cyan-200">
              Can I use my existing ServerByte web hosting instead of buying a VPS?
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              <strong>Yes, absolutely!</strong> ServerByte runs Apache/LiteSpeed, PHP 8.x, and MySQL natively. You can attach your ServerByte hosting account as an execution node in this panel. Static HTML/JS websites deploy instantly through our Serverless Cloud Engine, while PHP websites deploy directly to your ServerByte webroot with MySQL databases!
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs">
          <div className="text-xs font-semibold text-slate-400 uppercase">Connected Nodes</div>
          <div className="text-2xl font-bold text-slate-900 mt-2">{nodes.length} Nodes</div>
          <p className="text-xs text-slate-500 mt-1">Shared hosting & worker servers</p>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs">
          <div className="text-xs font-semibold text-slate-400 uppercase">Execution Runtimes</div>
          <div className="text-2xl font-bold text-cyan-700 mt-2">Static + PHP 8.x</div>
          <p className="text-xs text-slate-500 mt-1">HTML5, React, WordPress, Laravel</p>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs">
          <div className="text-xs font-semibold text-slate-400 uppercase">Cluster Health</div>
          <div className="text-2xl font-bold text-emerald-600 mt-2">Optimal</div>
          <p className="text-xs text-slate-500 mt-1">Storage & Network live</p>
        </div>
      </div>

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <h3 className="font-bold text-sm text-slate-800">Registered Execution Nodes</h3>
          <span className="text-xs text-slate-500">{nodes.length} registered</span>
        </div>

        {nodes.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <div className="inline-flex p-3 bg-slate-100 rounded-full text-slate-400">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
              </svg>
            </div>
            <h4 className="text-sm font-semibold text-slate-800">No external nodes attached yet</h4>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Your static websites run automatically on the Serverless Cloud Engine. To host dynamic PHP & MySQL websites, attach your ServerByte cPanel account using the button above.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-block mt-2 px-3 py-1.5 text-xs font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
            >
              + Attach ServerByte Web Hosting
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-white text-slate-400 font-semibold text-xs uppercase border-b border-slate-100">
                <tr>
                  <th className="py-3 px-4">Node Name</th>
                  <th className="py-3 px-4">Hostname / IP</th>
                  <th className="py-3 px-4">Provider / Runtime</th>
                  <th className="py-3 px-4">Region</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {nodes.map((node: any) => (
                  <tr key={node.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-slate-900">
                      {node.name}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-600">
                      <div>{node.hostname}</div>
                      <div className="text-[11px] text-slate-400">{node.ip_address}</div>
                    </td>
                    <td className="py-3.5 px-4 text-xs">
                      <div className="font-semibold text-slate-800">
                        {node.capabilities?.provider === "cpanel"
                          ? "ServerByte (cPanel Linux)"
                          : "VPS Node (Docker/Nginx)"}
                      </div>
                      <div className="text-[11px] text-cyan-700 font-medium mt-0.5">
                        PHP {node.capabilities?.php_version || "8.2"} • {node.capabilities?.disk_free_mb ? `${Math.round(node.capabilities.disk_free_mb / 1024)} GB Free Space` : "Unlimited Storage"}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-xs">{node.region}</td>
                    <td className="py-3.5 px-4">
                      <span className="inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                        {node.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <Form method="post" onSubmit={(e) => {
                        if (!confirm(`Are you sure you want to disconnect ${node.name}?`)) {
                          e.preventDefault();
                        }
                      }}>
                        <input type="hidden" name="intent" value="delete_node" />
                        <input type="hidden" name="node_id" value={node.id} />
                        <button
                          type="submit"
                          className="text-xs font-semibold text-red-600 hover:text-red-800"
                        >
                          Disconnect
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Connect Node Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-slate-900 text-base">
                Connect Server Node or Existing Web Hosting
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>

            <Form method="post" className="p-6 space-y-4" onSubmit={() => setShowAddModal(false)}>
              <input type="hidden" name="intent" value="create_node" />

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Node / Server Label *
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  placeholder="e.g. ServerByte cPanel Account 01"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Hostname / Domain *
                  </label>
                  <input
                    type="text"
                    name="hostname"
                    required
                    placeholder="e.g. serverbyte.yourdomain.com"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Server IP Address *
                  </label>
                  <input
                    type="text"
                    name="ip_address"
                    required
                    placeholder="e.g. 103.xxx.xxx.xxx"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Hosting Environment Type
                  </label>
                  <select
                    name="provider_type"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-white"
                  >
                    <option value="cpanel">ServerByte / cPanel (PHP 8.x + MySQL)</option>
                    <option value="directadmin">DirectAdmin Shared Hosting</option>
                    <option value="vps">Dedicated VPS / Ubuntu Cloud Worker</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Region
                  </label>
                  <input
                    type="text"
                    name="region"
                    defaultValue="ap-south-1 (India)"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                <span className="text-[11px] font-bold text-slate-700 uppercase block">
                  Deployment / FTP Settings (Optional)
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">FTP Host</label>
                    <input
                      type="text"
                      name="ftp_host"
                      placeholder="e.g. ftp.yourdomain.com"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">FTP Username</label>
                    <input
                      type="text"
                      name="ftp_user"
                      placeholder="e.g. cpanel_user"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 disabled:opacity-50"
                >
                  {isSubmitting ? "Connecting..." : "Save & Register Node"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
