import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { requireRole } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Server Nodes | DDL Group Hosting Panel" }];
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

export default function ServerNodes() {
  const { nodes } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Isolated Execution Server Nodes
        </h1>
        <p className="text-sm text-slate-500">
          Monitor status, health, and resource capacity of physical and containerized worker nodes
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs">
          <div className="text-xs font-semibold text-slate-400 uppercase">Total Active Nodes</div>
          <div className="text-2xl font-bold text-slate-900 mt-2">2 Nodes</div>
          <p className="text-xs text-slate-500 mt-1">Hetzner & AWS Cloud</p>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs">
          <div className="text-xs font-semibold text-slate-400 uppercase">Worker Node Status</div>
          <div className="text-2xl font-bold text-emerald-600 mt-2">100% Online</div>
          <p className="text-xs text-slate-500 mt-1">FastCGI & WSGI daemon running</p>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-xs">
          <div className="text-xs font-semibold text-slate-400 uppercase">Average Node Load</div>
          <div className="text-2xl font-bold text-slate-900 mt-2">18%</div>
          <p className="text-xs text-slate-500 mt-1">CPU & Memory headroom healthy</p>
        </div>
      </div>

      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <h3 className="font-bold text-sm text-slate-800">Node Cluster Overview</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-white text-slate-400 font-semibold text-xs uppercase border-b border-slate-100">
              <tr>
                <th className="py-3 px-4">Node Name</th>
                <th className="py-3 px-4">IP / Hostname</th>
                <th className="py-3 px-4">Region</th>
                <th className="py-3 px-4">Load</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="hover:bg-slate-50/80 transition-colors">
                <td className="py-3.5 px-4 font-semibold text-slate-900">node-01-prod</td>
                <td className="py-3.5 px-4 font-mono text-xs text-slate-600">142.93.18.22 / worker01.ddlgroup.host</td>
                <td className="py-3.5 px-4 text-xs">ap-south-1 (Mumbai)</td>
                <td className="py-3.5 px-4 text-xs font-bold text-slate-700">22%</td>
                <td className="py-3.5 px-4">
                  <span className="inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                    Active
                  </span>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/80 transition-colors">
                <td className="py-3.5 px-4 font-semibold text-slate-900">node-02-prod</td>
                <td className="py-3.5 px-4 font-mono text-xs text-slate-600">142.93.19.45 / worker02.ddlgroup.host</td>
                <td className="py-3.5 px-4 text-xs">ap-south-1 (Mumbai)</td>
                <td className="py-3.5 px-4 text-xs font-bold text-slate-700">14%</td>
                <td className="py-3.5 px-4">
                  <span className="inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                    Active
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
