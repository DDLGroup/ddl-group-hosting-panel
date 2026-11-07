import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import {
  DEFAULT_CLUSTER_HOST,
  DEFAULT_CLUSTER_PORT,
  deleteDatabaseSecret,
  dropTiDBDatabase,
  executeDatabaseQuery,
  generateSecurePassword,
  getDatabaseDetails,
  provisionTiDBDatabase,
  setDatabaseDetails,
  testMySQLConnection,
  updateTiDBUserPassword,
} from "~/utils/databaseSecrets.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "MySQL Databases | DDL Group Hosting Panel" }];
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

  const rawDbs = dbRes.data || [];
  const databasesWithDetails = await Promise.all(
    rawDbs.map(async (db: any) => {
      const details = await getDatabaseDetails(db.id);
      return {
        ...db,
        database_password: details.database_password,
        database_host: details.database_host || DEFAULT_CLUSTER_HOST,
        database_port: details.database_port || DEFAULT_CLUSTER_PORT,
      };
    })
  );

  return Response.json({
    databases: databasesWithDetails,
    projects: projectsRes.data || [],
    serverNodes: nodesRes.data || [],
    defaultHost: DEFAULT_CLUSTER_HOST,
    defaultPort: DEFAULT_CLUSTER_PORT,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  // Test Connection Action
  if (intent === "test_connection") {
    const host = String(formData.get("db_host") || DEFAULT_CLUSTER_HOST).trim();
    const user = String(formData.get("db_user") || "").trim();
    const pass = String(formData.get("db_password") || "").trim();
    const db = String(formData.get("db_name") || "").trim();
    const port = parseInt(String(formData.get("db_port") || "3306"), 10);

    if (!user) {
      return Response.json({ testError: "Username is required to test MySQL connection." }, { status: 400 });
    }

    const result = await testMySQLConnection({ host, user, pass, db, port });
    if (!result.success) {
      return Response.json({
        testError: `Connection Failed: ${result.error || "Unknown MySQL error"} (Host: ${result.host_used})`,
      });
    }

    return Response.json({
      testSuccess: `Connection Verified! Connected to ${result.version || "MariaDB"} on ${result.host_used}${
        result.tables_count !== undefined ? ` (${result.tables_count} tables detected)` : ""
      }`,
    });
  }

  // Create Database Action
  if (intent === "create_db") {
    const rawDbName = String(formData.get("db_name") || "").trim();
    const rawDbUser = String(formData.get("db_user") || "").trim();
    const dbHost = String(formData.get("db_host") || DEFAULT_CLUSTER_HOST).trim();
    const dbPort = parseInt(String(formData.get("db_port") || "3306"), 10);
    const projectId = formData.get("project_id");
    const serverNodeId = formData.get("server_node_id");
    let dbPassword = String(formData.get("db_password") || "").trim();

    if (!rawDbName || !rawDbUser) {
      return Response.json({ error: "Database name and username are required." }, { status: 400 });
    }

    if (!dbPassword) {
      dbPassword = generateSecurePassword();
    }

    // Preserve valid database naming conventions
    const cleanDbName = rawDbName.replace(/[^a-zA-Z0-9_\-]/g, "");
    const cleanUser = rawDbUser.replace(/[^a-zA-Z0-9_\-]/g, "");

    let userToSave = cleanUser;

    // Automatically provision database and user on TiDB Cloud
    if (dbHost.includes("tidbcloud.com")) {
      const provRes = await provisionTiDBDatabase({
        database_name: cleanDbName,
        database_user: cleanUser,
        database_password: dbPassword,
      });

      if (!provRes.success) {
        return Response.json(
          {
            error: `TiDB Cloud Provisioning Failed: ${provRes.error}. (Please verify root cluster credentials).`,
          },
          { status: 500 }
        );
      }
      userToSave = provRes.formatted_user;
    }

    const { data: newDb, error } = await supabaseAdmin
      .from("databases")
      .insert({
        customer_id: profile.id,
        project_id: projectId ? String(projectId) : null,
        server_node_id: serverNodeId ? String(serverNodeId) : null,
        database_name: cleanDbName,
        database_user: userToSave,
        status: "active",
      })
      .select()
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (newDb?.id) {
      await setDatabaseDetails(newDb.id, {
        database_password: dbPassword,
        database_host: dbHost,
        database_port: dbPort,
      });
    }

    return Response.json({
      success: `🎉 MySQL database "${cleanDbName}" automatically provisioned and active on TiDB Cloud (Port ${dbPort})!`,
    });
  }

  // Update Password Action
  if (intent === "update_db_password") {
    const dbId = String(formData.get("database_id") || "");
    const newPassword = String(formData.get("new_password") || "").trim();
    const newHost = String(formData.get("db_host") || "").trim();

    if (!dbId || !newPassword) {
      return Response.json({ error: "Database ID and new password are required." }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return Response.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    // Verify ownership
    let q = supabaseAdmin.from("databases").select("id, database_name, database_user").eq("id", dbId);
    if (profile.role === "customer") {
      q = q.eq("customer_id", profile.id);
    }

    const { data: db, error: fetchErr } = await q.maybeSingle();
    if (fetchErr || !db) {
      return Response.json({ error: "Database not found or access denied." }, { status: 404 });
    }

    const current = await getDatabaseDetails(dbId);
    if ((newHost || current.database_host)?.includes("tidbcloud.com")) {
      const updateRes = await updateTiDBUserPassword(db.database_user, newPassword);
      if (!updateRes.success) {
        return Response.json({ error: `TiDB Cloud Password Update Failed: ${updateRes.error}` }, { status: 500 });
      }
    }

    await setDatabaseDetails(dbId, {
      database_password: newPassword,
      database_host: newHost || current.database_host || DEFAULT_CLUSTER_HOST,
      database_port: current.database_port || DEFAULT_CLUSTER_PORT,
    });

    return Response.json({ success: `Password and credentials for "${db.database_name}" updated successfully!` });
  }

  // Delete Database Action
  if (intent === "delete_db") {
    const dbId = formData.get("database_id");
    if (typeof dbId !== "string" || !dbId) {
      return Response.json({ error: "Database ID is required." }, { status: 400 });
    }

    // Verify ownership and get details before deleting
    let q = supabaseAdmin.from("databases").select("id, database_name, database_user").eq("id", dbId);
    if (profile.role === "customer") {
      q = q.eq("customer_id", profile.id);
    }
    const { data: db } = await q.maybeSingle();

    if (db) {
      const details = await getDatabaseDetails(dbId);
      if (details.database_host?.includes("tidbcloud.com")) {
        await dropTiDBDatabase({
          database_name: db.database_name,
          database_user: db.database_user,
        });
      }
    }

    const { error } = await supabaseAdmin.from("databases").delete().eq("id", dbId);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await deleteDatabaseSecret(dbId);
    return Response.json({ success: "MySQL database deleted successfully from TiDB Cloud." });
  }

  // Execute SQL in Studio Action
  if (intent === "run_sql") {
    const dbName = String(formData.get("db_name") || "").trim();
    const sqlQuery = String(formData.get("sql_query") || "").trim();

    if (!dbName || !sqlQuery) {
      return Response.json({ sqlError: "Database name and SQL query are required." }, { status: 400 });
    }

    // Verify ownership
    let q = supabaseAdmin.from("databases").select("id, database_name").eq("database_name", dbName);
    if (profile.role === "customer") {
      q = q.eq("customer_id", profile.id);
    }
    const { data: db, error: fetchErr } = await q.maybeSingle();
    if (fetchErr || !db) {
      return Response.json({ sqlError: "Database not found or access denied." }, { status: 404 });
    }

    const result = await executeDatabaseQuery({ database_name: dbName, sql: sqlQuery });
    if (!result.success) {
      return Response.json({ sqlError: result.error, sqlQuery, dbName });
    }

    return Response.json({
      sqlSuccess: true,
      sqlQuery,
      dbName,
      columns: result.columns || [],
      rows: result.rows || [],
      affectedRows: result.affectedRows,
      executionTimeMs: result.executionTimeMs,
    });
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function Databases() {
  const { databases, projects, serverNodes, defaultHost, defaultPort } = useLoaderData<typeof loader>();
  const actionData = useActionData<{
    error?: string;
    success?: string;
    testError?: string;
    testSuccess?: string;
    sqlSuccess?: boolean;
    sqlError?: string;
    sqlQuery?: string;
    dbName?: string;
    columns?: string[];
    rows?: any[];
    affectedRows?: number;
    executionTimeMs?: number;
  }>();
  const navigation = useNavigation();
  const submit = useSubmit();

  // Modals state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDb, setSelectedDb] = useState<any>(null);
  const [editingPasswordDb, setEditingPasswordDb] = useState<any>(null);
  const [sqlStudioDb, setSqlStudioDb] = useState<any>(null);
  const [sqlQueryInput, setSqlQueryInput] = useState("SHOW TABLES;");

  // Password fields state
  const [createDbName, setCreateDbName] = useState("");
  const [createDbUser, setCreateDbUser] = useState("");
  const [createDbHost, setCreateDbHost] = useState(defaultHost);
  const [createDbPassword, setCreateDbPassword] = useState("");
  const [showCreatePassword, setShowCreatePassword] = useState(false);

  const [editDbHost, setEditDbHost] = useState("");
  const [newPasswordVal, setNewPasswordVal] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showCredsPassword, setShowCredsPassword] = useState(false);

  const [copiedField, setCopiedField] = useState<string | null>(null);
  const isSubmitting = navigation.state === "submitting";

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleGeneratePassword = (target: "create" | "update") => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
    let p = "Ddl_";
    for (let i = 0; i < 12; i++) {
      p += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (target === "create") {
      setCreateDbPassword(p);
      setShowCreatePassword(true);
    } else {
      setNewPasswordVal(p);
      setShowNewPassword(true);
    }
  };

  const handleCopyAndLaunchPma = (db: any) => {
    if (db.database_password) {
      navigator.clipboard.writeText(db.database_password);
      setCopiedField("pma_launch");
      setTimeout(() => setCopiedField(null), 2500);
    }
    const hostWithPort = db.database_host?.includes(":")
      ? db.database_host
      : `${db.database_host || defaultHost}:3306`;
    const pmaUrl = `https://panel.ddlg.in/sites/pma/?server=${encodeURIComponent(
      hostWithPort
    )}&username=${encodeURIComponent(db.database_user)}&db=${encodeURIComponent(db.database_name)}`;
    window.open(pmaUrl, "_blank");
  };

  const handleTestConnection = (e: React.MouseEvent) => {
    e.preventDefault();
    const form = new FormData();
    form.append("intent", "test_connection");
    form.append("db_host", createDbHost);
    form.append("db_user", createDbUser);
    form.append("db_password", createDbPassword);
    form.append("db_name", createDbName);
    submit(form, { method: "POST" });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <span>MySQL Databases</span>
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800 border border-cyan-200">
              TiDB Cloud Powered
            </span>
          </h1>
          <p className="text-sm text-slate-500">
            Automated 1-click cloud MySQL databases with instant provisioning, credentials management, and phpMyAdmin access
          </p>
        </div>

        <div className="flex items-center gap-3">
          <a
            href={`https://panel.ddlg.in/sites/pma/?server=${encodeURIComponent(defaultHost + ":3306")}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 shadow-xs transition"
          >
            <span>🗄️</span>
            <span>Open Web phpMyAdmin</span>
            <span className="text-xs text-slate-400">↗</span>
          </a>

          <button
            onClick={() => {
              handleGeneratePassword("create");
              setCreateDbHost(defaultHost);
              setIsModalOpen(true);
            }}
            className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
          >
            + Provision Database
          </button>
        </div>
      </div>

      {/* Cluster Guidance Card */}
      <div className="p-4 bg-gradient-to-r from-slate-900 via-slate-800 to-cyan-950 text-white rounded-2xl shadow-sm border border-slate-700 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-xs uppercase tracking-wider font-bold text-cyan-400">
              TiDB Cloud Engine (MySQL 8.0 Wire-Compatible)
            </span>
          </div>
          <p className="text-sm text-slate-200">
            Databases and users are provisioned 100% automatically in 1 click on TiDB Cloud Serverless.
          </p>
          <div className="text-xs text-slate-400 flex flex-wrap items-center gap-3 pt-1">
            <span>
              Primary Cluster Host: <code className="text-cyan-300 font-mono font-bold">{defaultHost}</code>
            </span>
            <span>•</span>
            <span>Port: <code className="text-cyan-300 font-mono font-bold">4000 / 3306</code></span>
            <span>•</span>
            <span>Web File Storage: <span className="text-slate-300 font-medium">ServerByte</span></span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <a
            href={`https://panel.ddlg.in/sites/pma/?server=${encodeURIComponent(defaultHost + ":3306")}`}
            target="_blank"
            rel="noreferrer"
            className="px-3.5 py-2 text-xs font-bold text-slate-900 bg-cyan-400 hover:bg-cyan-300 rounded-xl transition shadow-xs flex items-center gap-1.5"
          >
            <span>Launch phpMyAdmin</span>
            <span>↗</span>
          </a>
        </div>
      </div>

      {actionData?.error && (
        <div className="p-4 text-sm font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between">
          <span>{actionData.error}</span>
        </div>
      )}

      {actionData?.success && (
        <div className="p-4 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl">
          {actionData.success}
        </div>
      )}

      {actionData?.testError && (
        <div className="p-4 text-sm font-medium text-amber-900 bg-amber-50 border border-amber-300 rounded-xl">
          ⚠️ {actionData.testError}
        </div>
      )}

      {actionData?.testSuccess && (
        <div className="p-4 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-xl">
          ✅ {actionData.testSuccess}
        </div>
      )}

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">Database Name</th>
                <th className="py-3.5 px-4">Username</th>
                <th className="py-3.5 px-4">Cluster Host : Port</th>
                <th className="py-3.5 px-4">Mapped Website</th>
                <th className="py-3.5 px-4">Database Engine</th>
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
                    <p className="text-xs text-slate-400 mt-1">
                      Register or attach a database instance to connect with WordPress, Laravel, or PHP scripts.
                    </p>
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
                    <td className="py-3.5 px-4 font-mono text-xs text-cyan-800">
                      {db.database_host || defaultHost}:{db.database_port || defaultPort}
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
                    <td className="py-3.5 px-4 text-xs">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-50 border border-cyan-200 text-cyan-800 font-semibold">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-500"></span>
                        TiDB Cloud Serverless
                      </span>
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
                          onClick={() => {
                            setSelectedDb(db);
                            setShowCredsPassword(false);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
                          title="View Connection String & Credentials"
                        >
                          🔑 Credentials
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPasswordDb(db);
                            setEditDbHost(db.database_host || defaultHost);
                            handleGeneratePassword("update");
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition"
                          title="Update Database Password"
                        >
                          ✏️ Password
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSqlStudioDb(db);
                            setSqlQueryInput("SHOW TABLES;");
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition flex items-center gap-1"
                          title="Open Interactive SQL Studio"
                        >
                          <span>⚡</span>
                          <span>SQL Studio</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopyAndLaunchPma(db)}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                          title="Copy Password & Open in Web phpMyAdmin"
                        >
                          phpMyAdmin ↗
                        </button>
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
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Provision / Connect MySQL Database</h2>
                <p className="text-xs text-slate-500">Configure database credentials for your web applications</p>
              </div>
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
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-slate-700">
                    MySQL Host / Cluster Host
                  </label>
                  <span className="text-[11px] font-semibold text-cyan-700 bg-cyan-50 px-2 py-0.5 rounded border border-cyan-200">
                    TiDB Cloud Serverless
                  </span>
                </div>
                <input
                  type="text"
                  name="db_host"
                  value={createDbHost}
                  onChange={(e) => setCreateDbHost(e.target.value)}
                  required
                  placeholder={defaultHost}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-slate-50"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Automated provisioning on TiDB Cloud Serverless (MySQL 8.0 wire-compatible) on port 4000.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Database Name
                  </label>
                  <input
                    type="text"
                    name="db_name"
                    value={createDbName}
                    onChange={(e) => setCreateDbName(e.target.value)}
                    required
                    placeholder="e.g. ddl_store_db"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Database Username
                  </label>
                  <input
                    type="text"
                    name="db_user"
                    value={createDbUser}
                    onChange={(e) => setCreateDbUser(e.target.value)}
                    required
                    placeholder="e.g. usr_store_admin"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-slate-700">
                    Database Password
                  </label>
                  <button
                    type="button"
                    onClick={() => handleGeneratePassword("create")}
                    className="text-xs font-semibold text-cyan-600 hover:text-cyan-700 transition"
                  >
                    🎲 Generate Strong Password
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showCreatePassword ? "text" : "password"}
                    name="db_password"
                    value={createDbPassword}
                    onChange={(e) => setCreateDbPassword(e.target.value)}
                    required
                    placeholder="Enter or generate password"
                    className="w-full px-3 py-2 pr-10 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCreatePassword(!showCreatePassword)}
                    className="absolute inset-y-0 right-0 px-3 flex items-center text-xs text-slate-400 hover:text-slate-600"
                  >
                    {showCreatePassword ? "Hide" : "Show"}
                  </button>
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

              <input type="hidden" name="server_node_id" value={serverNodes[0]?.id || ""} />

              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700">Database Engine Architecture</span>
                  <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800 border border-cyan-200">
                    TiDB Cloud Serverless
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-emerald-500">🔒</span>
                    <span className="font-medium text-slate-700">AWS Singapore Cluster with Encrypted TLS / SSL</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-cyan-600">⚡</span>
                    <span>Automated user isolation and 1-click phpMyAdmin access</span>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-700">Verify TiDB Cloud Connection</div>
                  <div className="text-[11px] text-slate-400">Tests live TLS/SSL handshake to TiDB cluster</div>
                </div>
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 shadow-xs transition"
                >
                  {isSubmitting ? "Testing..." : "Test Connection"}
                </button>
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
                  Save & Provision Database
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Update Password Modal */}
      {editingPasswordDb && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-md p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-xl">🔐</span>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Update Credentials</h2>
                  <p className="text-xs text-slate-500">{editingPasswordDb.database_name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingPasswordDb(null)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setEditingPasswordDb(null)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="update_db_password" />
              <input type="hidden" name="database_id" value={editingPasswordDb.id} />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Cluster Host
                </label>
                <input
                  type="text"
                  name="db_host"
                  value={editDbHost}
                  onChange={(e) => setEditDbHost(e.target.value)}
                  required
                  placeholder={defaultHost}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-slate-700">
                    New Password
                  </label>
                  <button
                    type="button"
                    onClick={() => handleGeneratePassword("update")}
                    className="text-xs font-semibold text-cyan-600 hover:text-cyan-700 transition"
                  >
                    🎲 Generate Strong Password
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showNewPassword ? "text" : "password"}
                    name="new_password"
                    value={newPasswordVal}
                    onChange={(e) => setNewPasswordVal(e.target.value)}
                    required
                    placeholder="Enter new password"
                    className="w-full px-3 py-2 pr-10 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute inset-y-0 right-0 px-3 flex items-center text-xs text-slate-400 hover:text-slate-600"
                  >
                    {showNewPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Update this in your <code>wp-config.php</code> or <code>.env</code> file if used by WordPress or scripts.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setEditingPasswordDb(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Save Credentials
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
                    <span className="font-mono font-bold text-slate-900 truncate mr-2" title={selectedDb.database_host || defaultHost}>
                      {selectedDb.database_host || defaultHost}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(selectedDb.database_host || defaultHost, "host")}
                      className="text-xs text-cyan-600 hover:underline shrink-0"
                    >
                      {copiedField === "host" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-400 uppercase block">Port</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono font-bold text-slate-900">
                      {selectedDb.database_port || defaultPort}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(String(selectedDb.database_port || defaultPort), "port")}
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

              {/* Password field with Show/Hide and Copy */}
              <div className="p-3.5 bg-cyan-50/60 border border-cyan-200 rounded-xl">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-cyan-800 uppercase block">Database Password</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowCredsPassword(!showCredsPassword)}
                      className="text-xs font-semibold text-cyan-700 hover:underline"
                    >
                      {showCredsPassword ? "Hide" : "Show Password"}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(selectedDb.database_password || "", "password")}
                      className="text-xs font-semibold text-cyan-700 hover:underline"
                    >
                      {copiedField === "password" ? "Copied!" : "Copy Password"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPasswordDb(selectedDb);
                        setEditDbHost(selectedDb.database_host || defaultHost);
                        handleGeneratePassword("update");
                      }}
                      className="text-xs font-semibold text-amber-700 hover:underline"
                    >
                      ✏️ Change
                    </button>
                  </div>
                </div>
                <div className="mt-1 font-mono font-bold text-slate-900 text-sm tracking-wider select-all">
                  {showCredsPassword ? selectedDb.database_password : "••••••••••••••••"}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-slate-700 uppercase block">
                    WordPress wp-config.php Snippet
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const hostStr =
                        selectedDb.database_port && selectedDb.database_port !== 3306
                          ? `${selectedDb.database_host || defaultHost}:${selectedDb.database_port}`
                          : selectedDb.database_host || defaultHost;
                      const snippet = `define( 'DB_NAME', '${selectedDb.database_name}' );\ndefine( 'DB_USER', '${selectedDb.database_user}' );\ndefine( 'DB_PASSWORD', '${selectedDb.database_password || ""}' );\ndefine( 'DB_HOST', '${hostStr}' );\ndefine( 'DB_CHARSET', 'utf8mb4' );`;
                      copyToClipboard(snippet, "snippet");
                    }}
                    className="text-xs font-semibold text-cyan-600 hover:underline"
                  >
                    {copiedField === "snippet" ? "Copied Snippet!" : "Copy Full Snippet"}
                  </button>
                </div>
                <pre className="p-3 bg-slate-900 text-cyan-300 font-mono text-xs rounded-xl overflow-x-auto select-all leading-relaxed">
{`define( 'DB_NAME', '${selectedDb.database_name}' );
define( 'DB_USER', '${selectedDb.database_user}' );
define( 'DB_PASSWORD', '${selectedDb.database_password || ""}' );
define( 'DB_HOST', '${
  selectedDb.database_port && selectedDb.database_port !== 3306
    ? `${selectedDb.database_host || defaultHost}:${selectedDb.database_port}`
    : selectedDb.database_host || defaultHost
}' );
define( 'DB_CHARSET', 'utf8mb4' );`}
                </pre>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => handleCopyAndLaunchPma(selectedDb)}
                  className="inline-flex items-center justify-center gap-2 text-xs font-bold text-white bg-cyan-600 px-4 py-2.5 rounded-xl hover:bg-cyan-700 shadow-sm transition"
                >
                  <span>⚡ Copy Password & Open in phpMyAdmin</span>
                  <span>↗</span>
                </button>

                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setSelectedDb(null)}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Interactive SQL Studio Modal */}
      {sqlStudioDb && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="w-full max-w-4xl p-6 bg-white rounded-2xl shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-lg">
                  ⚡
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <span>SQL Studio</span>
                    <span className="text-xs font-mono font-semibold px-2.5 py-0.5 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200">
                      {sqlStudioDb.database_name}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-500">
                    Direct live query console connected to TiDB Cloud cluster ({defaultHost})
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSqlStudioDb(null)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1 rounded-lg text-lg"
              >
                ✕
              </button>
            </div>

            <div className="pt-4 flex-1 overflow-y-auto space-y-4">
              {/* Quick Query Shortcuts */}
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-slate-500">Quick Queries:</span>
                <button
                  type="button"
                  onClick={() => setSqlQueryInput("SHOW TABLES;")}
                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono rounded-lg transition"
                >
                  SHOW TABLES;
                </button>
                <button
                  type="button"
                  onClick={() => setSqlQueryInput("SELECT VERSION(), DATABASE(), USER();")}
                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono rounded-lg transition"
                >
                  CLUSTER INFO
                </button>
                <button
                  type="button"
                  onClick={() => setSqlQueryInput("SHOW TABLE STATUS;")}
                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-mono rounded-lg transition"
                >
                  TABLE STATUS
                </button>
              </div>

              {/* SQL Input Form */}
              <Form method="POST" className="space-y-3">
                <input type="hidden" name="intent" value="run_sql" />
                <input type="hidden" name="db_name" value={sqlStudioDb.database_name} />

                <div className="relative">
                  <textarea
                    name="sql_query"
                    value={sqlQueryInput}
                    onChange={(e) => setSqlQueryInput(e.target.value)}
                    rows={4}
                    placeholder="Enter SQL statement (e.g. SHOW TABLES; or SELECT * FROM users;)"
                    className="w-full p-3 font-mono text-sm bg-slate-900 text-emerald-400 border border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 selection:bg-emerald-800"
                    required
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-slate-400">
                    Supports DDL, DML, and queries (CREATE, SELECT, INSERT, UPDATE, SHOW).
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="submit" loading={isSubmitting}>
                      ▶ Run SQL Query
                    </Button>
                  </div>
                </div>
              </Form>

              {/* SQL Result Feedback */}
              {actionData?.sqlError && (
                <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs font-mono">
                  <span className="font-bold">Error:</span> {actionData.sqlError}
                </div>
              )}

              {actionData?.sqlSuccess && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500 px-1">
                    <span className="text-emerald-700 font-semibold flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
                      Query executed successfully in {actionData.executionTimeMs}ms
                    </span>
                    {actionData.rows && (
                      <span>
                        Showing {actionData.rows.length} row{actionData.rows.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    {actionData.affectedRows !== undefined && (
                      <span>{actionData.affectedRows} row(s) affected</span>
                    )}
                  </div>

                  {actionData.rows && actionData.rows.length > 0 ? (
                    <div className="overflow-x-auto border border-slate-200 rounded-xl max-h-72">
                      <table className="w-full text-left text-xs font-mono text-slate-700 divide-y divide-slate-200">
                        <thead className="bg-slate-100 text-slate-600 font-bold uppercase sticky top-0">
                          <tr>
                            {actionData.columns?.map((col) => (
                              <th key={col} className="p-2.5 border-r border-slate-200 last:border-r-0">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {actionData.rows.map((row, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              {actionData.columns?.map((col) => (
                                <td key={col} className="p-2.5 border-r border-slate-100 last:border-r-0 truncate max-w-xs">
                                  {typeof row[col] === "object" ? JSON.stringify(row[col]) : String(row[col] ?? "NULL")}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 border border-slate-200 rounded-xl font-mono">
                      Query completed with no rows returned.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <Button type="button" variant="outlined" onClick={() => setSqlStudioDb(null)}>
                Close Studio
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
