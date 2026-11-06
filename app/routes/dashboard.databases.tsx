import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Databases | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  let query = supabaseAdmin
    .from("databases")
    .select("*, hosting_projects(id, name, subdomain), server_nodes(id, name, hostname, ip_address)")
    .order("created_at", { ascending: false });

  let projectsQuery = supabaseAdmin
    .from("hosting_projects")
    .select("id, name, subdomain");

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
    projectsQuery = projectsQuery.eq("customer_id", profile.id);
  }

  const [dbRes, projectsRes, nodesRes] = await Promise.all([
    query,
    projectsQuery.order("name"),
    supabaseAdmin.from("server_nodes").select("id, name, hostname, ip_address, status"),
  ]);

  return Response.json({
    databases: dbRes.data || [],
    projects: projectsRes.data || [],
    serverNodes: nodesRes.data || [],
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  if (intent === "create_db") {
    const dbName = formData.get("db_name");
    const dbUser = formData.get("db_user");
    const projectId = formData.get("project_id");
    const serverNodeId = formData.get("server_node_id");

    if (
      typeof dbName !== "string" ||
      typeof dbUser !== "string" ||
      !dbName.trim() ||
      !dbUser.trim()
    ) {
      return Response.json({ error: "Database name and username are required." }, { status: 400 });
    }

    const cleanDbName = dbName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const cleanUser = dbUser.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");

    const { error } = await supabaseAdmin.from("databases").insert({
      customer_id: profile.id,
      project_id: projectId ? String(projectId) : null,
      server_node_id: serverNodeId ? String(serverNodeId) : null,
      database_name: `ddl_${cleanDbName}`,
      database_user: `usr_${cleanUser}`,
      status: "active",
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: `MySQL database "ddl_${cleanDbName}" created successfully!` });
  }

  if (intent === "delete_db") {
    const dbId = formData.get("database_id");
    if (typeof dbId !== "string" || !dbId) {
      return Response.json({ error: "Database ID is required." }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("databases").delete().eq("id", dbId);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: "MySQL database deleted successfully." });
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function Databases() {
  const { databases, projects, serverNodes } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDb, setSelectedDb] = useState<any>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const isSubmitting = navigation.state === "submitting";

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            MySQL Databases
          </h1>
          <p className="text-sm text-slate-500">
            Provision and manage isolated MySQL databases for your WordPress, PHP, and web applications
          </p>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="https://cp.serverbyt.in/services/85b8dc9d809f04e0/database/manage-mysql"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 shadow-xs transition"
          >
            <span>🗄️</span>
            <span>Open phpMyAdmin</span>
            <span className="text-xs text-slate-400">↗</span>
          </a>

          <button
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
          >
            + Provision Database
          </button>
        </div>
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

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">Database Name</th>
                <th className="py-3.5 px-4">Username</th>
                <th className="py-3.5 px-4">Host / Port</th>
                <th className="py-3.5 px-4">Mapped Website</th>
                <th className="py-3.5 px-4">Server Node</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {databases.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-slate-100 text-slate-400">
                      <span className="text-xl">🗄️</span>
                    </div>
                    <div className="font-semibold text-slate-700">No MySQL databases provisioned yet</div>
                    <p className="text-xs text-slate-400 mt-1">Create a database instance to connect with WordPress, Laravel, or PHP scripts.</p>
                  </td>
                </tr>
              ) : (
                databases.map((db: any) => (
                  <tr key={db.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-bold text-slate-900">
                      {db.database_name}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-600">
                      {db.database_user}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-500">
                      localhost:3306
                    </td>
                    <td className="py-3.5 px-4 text-xs font-medium text-slate-700">
                      {db.hosting_projects?.name ? (
                        <span className="px-2 py-0.5 rounded-md bg-cyan-50 text-cyan-800 border border-cyan-200">
                          {db.hosting_projects.name}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-600">
                      {db.server_nodes?.name || "ServerByte Node 01"}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                        {db.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedDb(db)}
                          className="px-2.5 py-1 text-xs font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
                          title="View Connection String & Credentials"
                        >
                          🔑 Credentials
                        </button>
                        <a
                          href="https://cp.serverbyt.in/services/85b8dc9d809f04e0/database/manage-mysql"
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                          title="Open phpMyAdmin Web Manager"
                        >
                          phpMyAdmin ↗
                        </a>
                        <Form
                          method="POST"
                          onSubmit={(e) => {
                            if (!confirm(`Are you sure you want to delete database "${db.database_name}"?`)) {
                              e.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="intent" value="delete_db" />
                          <input type="hidden" name="database_id" value={db.id} />
                          <button
                            type="submit"
                            className="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition"
                            title="Delete Database"
                          >
                            Delete
                          </button>
                        </Form>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Provision Database Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Provision MySQL Database</h2>
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
              <input type="hidden" name="intent" value="create_db" />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Database Name Suffix
                </label>
                <div className="flex items-center">
                  <span className="px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-100 border border-r-0 border-slate-200 rounded-l-lg">
                    ddl_
                  </span>
                  <input
                    type="text"
                    name="db_name"
                    required
                    placeholder="wordpress_db"
                    className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-r-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Database User Suffix
                </label>
                <div className="flex items-center">
                  <span className="px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-100 border border-r-0 border-slate-200 rounded-l-lg">
                    usr_
                  </span>
                  <input
                    type="text"
                    name="db_user"
                    required
                    placeholder="wp_admin"
                    className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-r-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Assign to Website Project
                </label>
                <select
                  name="project_id"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="">-- Standalone / General Database --</option>
                  {projects.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.subdomain}.ddlgroup.host)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Host Execution Server
                </label>
                <select
                  name="server_node_id"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  {serverNodes.map((n: any) => (
                    <option key={n.id} value={n.id}>
                      🖥️ {n.name} ({n.ip_address})
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-3 text-xs text-slate-500 bg-cyan-50/60 border border-cyan-100 rounded-xl">
                ℹ️ MySQL runs on port 3306 on your ServerByte Linux node. You can connect your WordPress, Laravel, or PHP scripts using Host <code>localhost</code>.
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
                  Provision Database
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Credentials Modal */}
      {selectedDb && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-xl p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🔑</span>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Database Connection Credentials</h2>
                  <p className="text-xs text-slate-500">{selectedDb.database_name}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedDb(null)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-400 uppercase block">Host</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono font-bold text-slate-900">localhost</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard("localhost", "host")}
                      className="text-xs text-cyan-600 hover:underline"
                    >
                      {copiedField === "host" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-400 uppercase block">Port</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono font-bold text-slate-900">3306</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard("3306", "port")}
                      className="text-xs text-cyan-600 hover:underline"
                    >
                      {copiedField === "port" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-400 uppercase block">Database Name</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono font-bold text-slate-900 truncate mr-2">{selectedDb.database_name}</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(selectedDb.database_name, "db")}
                      className="text-xs text-cyan-600 hover:underline"
                    >
                      {copiedField === "db" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-400 uppercase block">Username</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono font-bold text-slate-900 truncate mr-2">{selectedDb.database_user}</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(selectedDb.database_user, "user")}
                      className="text-xs text-cyan-600 hover:underline"
                    >
                      {copiedField === "user" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <span className="text-xs font-bold text-slate-700 uppercase block mb-1.5">
                  WordPress wp-config.php Snippet
                </span>
                <pre className="p-3 bg-slate-900 text-cyan-300 font-mono text-xs rounded-xl overflow-x-auto select-all">
{`define( 'DB_NAME', '${selectedDb.database_name}' );
define( 'DB_USER', '${selectedDb.database_user}' );
define( 'DB_PASSWORD', 'your_mysql_password' );
define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8mb4' );`}
                </pre>
              </div>

              <div className="pt-2 flex justify-between items-center border-t border-slate-100">
                <a
                  href="https://cp.serverbyt.in/services/85b8dc9d809f04e0/database/manage-mysql"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-700 bg-cyan-50 px-3 py-2 rounded-xl hover:bg-cyan-100 transition"
                >
                  <span>🗄️ Manage in phpMyAdmin</span>
                  <span>↗</span>
                </a>

                <Button
                  type="button"
                  onClick={() => setSelectedDb(null)}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
