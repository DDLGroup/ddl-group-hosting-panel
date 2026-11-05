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
    .select("*, hosting_projects(name)")
    .order("created_at", { ascending: false });

  if (profile.role === "customer") {
    query = query.eq("customer_id", profile.id);
  }

  const { data: databases } = await query;

  return Response.json({ databases: databases || [] });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  if (intent === "create_db") {
    const dbName = formData.get("db_name");
    const dbUser = formData.get("db_user");

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
      database_name: `ddl_${cleanDbName}`,
      database_user: `usr_${cleanUser}`,
      status: "active",
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: "MySQL database instance provisioned successfully!" });
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function Databases() {
  const { databases } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            MySQL Databases
          </h1>
          <p className="text-sm text-slate-500">
            Provision and manage isolated MySQL databases for your applications
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
        >
          + Provision Database
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

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">Database Name</th>
                <th className="py-3.5 px-4">Username</th>
                <th className="py-3.5 px-4">Host / Port</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Created Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {databases.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    No MySQL databases provisioned yet.
                  </td>
                </tr>
              ) : (
                databases.map((db: any) => (
                  <tr key={db.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-semibold text-slate-900">
                      {db.database_name}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-600">
                      {db.database_user}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-500">
                      mysql.ddlgroup.host:3306
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                        {db.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">
                      {formatDate(db.created_at)}
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

              <TextField
                id="db_name"
                name="db_name"
                label="Database Suffix (e.g. blog, store)"
                type="text"
                required
                placeholder="myapp"
              />

              <TextField
                id="db_user"
                name="db_user"
                label="Database User"
                type="text"
                required
                placeholder="appuser"
              />

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
    </div>
  );
}
