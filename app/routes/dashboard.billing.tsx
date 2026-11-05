import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Billing & Plans | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  let invoicesQuery = supabaseAdmin
    .from("invoices")
    .select("*")
    .order("created_at", { ascending: false });

  if (profile.role === "customer") {
    invoicesQuery = invoicesQuery.eq("customer_id", profile.id);
  }

  const { data: invoices } = await invoicesQuery;
  const { data: plans } = await supabaseAdmin.from("hosting_plans").select("*");

  return Response.json({
    invoices: invoices || [],
    plans: plans || [],
    profile,
  });
}

export default function Billing() {
  const { invoices } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Invoices & Hosting Billing
        </h1>
        <p className="text-sm text-slate-500">
          Review subscription plans, service invoices, and payment receipts
        </p>
      </div>

      {/* Plan Card */}
      <div className="p-6 bg-gradient-to-r from-slate-900 to-cyan-950 text-white rounded-2xl shadow-md border border-slate-800">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-cyan-400">Current Plan</span>
            <h2 className="text-xl font-extrabold mt-1">Enterprise Cloud Tier</h2>
            <p className="text-xs text-slate-300 mt-1">
              Includes unlimited SSL certificates, automated daily snapshots, and isolated PHP & Python runtimes.
            </p>
          </div>
          <div className="text-right">
            <span className="text-3xl font-black text-white">$29</span>
            <span className="text-xs text-slate-400">/month</span>
          </div>
        </div>
      </div>

      {/* Invoices List */}
      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <h3 className="font-bold text-sm text-slate-800">Billing History</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-white text-slate-400 font-semibold text-xs uppercase border-b border-slate-100">
              <tr>
                <th className="py-3 px-4">Invoice #</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Due Date</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    No billing invoices generated yet.
                  </td>
                </tr>
              ) : (
                invoices.map((inv: any) => (
                  <tr key={inv.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-mono font-semibold text-xs text-slate-900">
                      {inv.invoice_number}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-900">
                      ${(inv.amount_cents / 100).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-500">
                      {formatDate(inv.due_date)}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full ${
                        inv.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button className="text-xs font-semibold text-cyan-600 hover:text-cyan-700">
                        Download PDF
                      </button>
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
