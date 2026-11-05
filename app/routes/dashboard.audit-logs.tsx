import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { requireRole } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Audit Logs | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requireRole(request, ["super_admin"]);
  const supabaseAdmin = getSupabaseAdminClient();

  const { data: logs } = await supabaseAdmin
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  return Response.json({ logs: logs || [] });
}

export default function AuditLogs() {
  const { logs } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Security Audit Logs
        </h1>
        <p className="text-sm text-slate-500">
          Immutable audit record of all administrative operations, logins, and status modifications
        </p>
      </div>

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">Action</th>
                <th className="py-3.5 px-4">Target Entity</th>
                <th className="py-3.5 px-4">Actor ID</th>
                <th className="py-3.5 px-4">Details</th>
                <th className="py-3.5 px-4">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    No administrative audit events recorded yet.
                  </td>
                </tr>
              ) : (
                logs.map((log: any) => (
                  <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-semibold text-xs text-slate-900">
                      {log.action}
                    </td>
                    <td className="py-3.5 px-4 text-xs font-mono text-slate-600">
                      {log.target_type}
                    </td>
                    <td className="py-3.5 px-4 text-xs font-mono text-slate-400">
                      {log.actor_id ? `${log.actor_id.slice(0, 8)}...` : "System"}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-500 max-w-xs truncate">
                      {JSON.stringify(log.details)}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-400">
                      {formatDate(log.created_at)}
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
