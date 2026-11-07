import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { logAuditEvent, requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Hosting Plans & Billing | DDL Group Hosting Panel" }];
};

export function parsePlanDetails(plan: any) {
  let tagline = "";
  let badge = "";
  let features: string[] = [];

  try {
    if (plan?.description && plan.description.startsWith("{")) {
      const parsed = JSON.parse(plan.description);
      tagline = parsed.tagline || "";
      badge = parsed.badge || "";
      features = Array.isArray(parsed.features) ? parsed.features : [];
    } else {
      tagline = plan?.description || "";
    }
  } catch {
    tagline = plan?.description || "";
  }

  if (features.length === 0 && plan) {
    features = [
      plan.max_websites >= 999 ? "Host Unlimited Websites" : `Host Up to ${plan.max_websites} Website${plan.max_websites > 1 ? "s" : ""}`,
      plan.max_storage_mb >= 1024 ? `${plan.max_storage_mb / 1024}GB Pure NVMe SSD Space` : `${plan.max_storage_mb} MB Pure NVMe SSD Space`,
      "1 Dedicated cPanel Account",
      "Unlimited Monthly Bandwidth",
      "Free Auto-SSL Certificate",
      "Free 1-click app installer",
      "1 Dedicated vCPU & 1GB RAM",
      "99.9% Cloud Uptime SLA",
    ];
  }

  return { tagline, badge, features };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  // Invoices
  let invoicesQuery = supabaseAdmin
    .from("invoices")
    .select("*")
    .order("created_at", { ascending: false });

  if (profile.role === "customer") {
    invoicesQuery = invoicesQuery.eq("customer_id", profile.id);
  }

  const { data: invoices } = await invoicesQuery;
  const { data: rawPlans } = await supabaseAdmin
    .from("hosting_plans")
    .select("*")
    .order("price_cents", { ascending: true });

  // Counts of subscribers per plan (for admin)
  const { data: accounts } = await supabaseAdmin
    .from("hosting_accounts")
    .select("plan_id");

  const planSubscriberMap: Record<string, number> = {};
  if (accounts) {
    for (const a of accounts) {
      if (a.plan_id) {
        planSubscriberMap[a.plan_id] = (planSubscriberMap[a.plan_id] || 0) + 1;
      }
    }
  }

  // Customer plan & usage
  let customerAccount: any = null;
  let usage = { websites: 0, databases: 0 };
  if (profile.role === "customer") {
    const { data: acc } = await supabaseAdmin
      .from("hosting_accounts")
      .select("*, hosting_plans(*)")
      .eq("customer_id", profile.id)
      .maybeSingle();
    customerAccount = acc;

    const [sitesRes, dbsRes] = await Promise.all([
      supabaseAdmin.from("hosting_projects").select("id", { count: "exact", head: true }).eq("customer_id", profile.id),
      supabaseAdmin.from("databases").select("id", { count: "exact", head: true }).eq("customer_id", profile.id),
    ]);
    usage = {
      websites: sitesRes.count || 0,
      databases: dbsRes.count || 0,
    };
  }

  return Response.json({
    invoices: invoices || [],
    plans: rawPlans || [],
    planSubscriberMap,
    customerAccount,
    usage,
    profile,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  // Admin checks for modifying plans
  const isAdmin = profile.role === "super_admin" || profile.role === "staff_admin";

  // 1. Create New Plan (Admin)
  if (intent === "create_plan") {
    if (!isAdmin) {
      return Response.json({ error: "Only administrators can create hosting plans." }, { status: 403 });
    }

    const name = String(formData.get("name") || "").trim();
    let slug = String(formData.get("slug") || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    const tagline = String(formData.get("tagline") || "").trim();
    const badge = String(formData.get("badge") || "").trim();
    const priceRupees = parseFloat(String(formData.get("price_rupees") || "0"));
    const maxWebsites = parseInt(String(formData.get("max_websites") || "1"), 10);
    const maxStorageMb = parseInt(String(formData.get("max_storage_mb") || "1024"), 10);
    const maxDatabases = parseInt(String(formData.get("max_databases") || "1"), 10);
    const rawFeatures = String(formData.get("features") || "");

    if (!name) {
      return Response.json({ error: "Plan name is required." }, { status: 400 });
    }

    if (!slug) {
      slug = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    }

    const features = rawFeatures
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    const description = JSON.stringify({
      tagline,
      badge,
      features,
    });

    const priceCents = Math.round(priceRupees * 100);

    const { data: newPlan, error } = await supabaseAdmin
      .from("hosting_plans")
      .insert({
        name,
        slug,
        description,
        price_cents: priceCents,
        billing_period: "monthly",
        max_websites: maxWebsites,
        max_storage_mb: maxStorageMb,
        max_databases: maxDatabases,
        max_bandwidth_mb: 500000,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent(profile.id, "CREATE_HOSTING_PLAN", "hosting_plans", newPlan.id, {
      name,
      slug,
      price_rupees: priceRupees,
      max_websites: maxWebsites,
      max_storage_mb: maxStorageMb,
    });

    return Response.json({ success: `Hosting plan "${name}" created successfully!` });
  }

  // 2. Edit Existing Plan (Admin)
  if (intent === "edit_plan") {
    if (!isAdmin) {
      return Response.json({ error: "Only administrators can edit hosting plans." }, { status: 403 });
    }

    const planId = String(formData.get("plan_id") || "").trim();
    const name = String(formData.get("name") || "").trim();
    const tagline = String(formData.get("tagline") || "").trim();
    const badge = String(formData.get("badge") || "").trim();
    const priceRupees = parseFloat(String(formData.get("price_rupees") || "0"));
    const maxWebsites = parseInt(String(formData.get("max_websites") || "1"), 10);
    const maxStorageMb = parseInt(String(formData.get("max_storage_mb") || "1024"), 10);
    const maxDatabases = parseInt(String(formData.get("max_databases") || "1"), 10);
    const rawFeatures = String(formData.get("features") || "");
    const isActive = formData.get("is_active") === "true";

    if (!planId || !name) {
      return Response.json({ error: "Plan ID and name are required." }, { status: 400 });
    }

    const features = rawFeatures
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    const description = JSON.stringify({
      tagline,
      badge,
      features,
    });

    const priceCents = Math.round(priceRupees * 100);

    const { error } = await supabaseAdmin
      .from("hosting_plans")
      .update({
        name,
        description,
        price_cents: priceCents,
        max_websites: maxWebsites,
        max_storage_mb: maxStorageMb,
        max_databases: maxDatabases,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq("id", planId);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent(profile.id, "UPDATE_HOSTING_PLAN", "hosting_plans", planId, {
      name,
      price_rupees: priceRupees,
      max_websites: maxWebsites,
      max_storage_mb: maxStorageMb,
      is_active: isActive,
    });

    return Response.json({ success: `Hosting plan "${name}" updated successfully!` });
  }

  // 3. Delete / Deactivate Plan (Admin)
  if (intent === "delete_plan") {
    if (!isAdmin) {
      return Response.json({ error: "Only administrators can delete hosting plans." }, { status: 403 });
    }

    const planId = String(formData.get("plan_id") || "").trim();
    if (!planId) {
      return Response.json({ error: "Plan ID is required." }, { status: 400 });
    }

    // Check if any accounts use this plan
    const { count } = await supabaseAdmin
      .from("hosting_accounts")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", planId);

    if ((count || 0) > 0) {
      // Deactivate instead of delete to protect active subscriptions
      await supabaseAdmin
        .from("hosting_plans")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", planId);

      return Response.json({
        success: `Plan has been deactivated instead of deleted because ${count} customer(s) are currently subscribed to it.`,
      });
    }

    const { error } = await supabaseAdmin.from("hosting_plans").delete().eq("id", planId);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent(profile.id, "DELETE_HOSTING_PLAN", "hosting_plans", planId, {});
    return Response.json({ success: "Plan deleted successfully!" });
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function Billing() {
  const { invoices, plans, planSubscriberMap, customerAccount, usage, profile } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();

  const isAdmin = profile.role === "super_admin" || profile.role === "staff_admin";
  const isSubmitting = navigation.state === "submitting";

  // Modals state
  const [isAddPlanModalOpen, setIsAddPlanModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<any>(null);

  // Form helper state for Add Plan
  const [addStorageMb, setAddStorageMb] = useState(1024);
  const [addWebsites, setAddWebsites] = useState(10);
  const [addDatabases, setAddDatabases] = useState(10);

  // Current customer plan details
  const myPlan = customerAccount?.hosting_plans;
  const myPlanDetails = myPlan ? parsePlanDetails(myPlan) : null;

  return (
    <div className="space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <span>{isAdmin ? "Hosting Plans & Pricing" : "Billing & Subscription"}</span>
            {isAdmin && (
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800 border border-cyan-200">
                Admin Panel
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500">
            {isAdmin
              ? "Configure plan features, set storage & website quotas, and manage customer subscriptions"
              : "Review your active hosting plan, resource quotas, and billing invoices"}
          </p>
        </div>

        {isAdmin && (
          <button
            onClick={() => setIsAddPlanModalOpen(true)}
            className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
          >
            + Add New Hosting Plan
          </button>
        )}
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

      {/* CUSTOMER ACTIVE PLAN CARD */}
      {!isAdmin && myPlan && (
        <div className="p-6 bg-gradient-to-r from-slate-900 via-slate-800 to-cyan-950 text-white rounded-2xl shadow-lg border border-slate-700 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-700/60">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-cyan-400">Your Active Plan</span>
                {myPlanDetails?.badge && (
                  <span className="px-2 py-0.5 text-[10px] font-extrabold uppercase rounded bg-rose-500 text-white">
                    {myPlanDetails.badge}
                  </span>
                )}
              </div>
              <h2 className="text-2xl font-extrabold mt-1 text-white">{myPlan.name}</h2>
              <p className="text-xs text-slate-300 mt-1 max-w-xl">
                {myPlanDetails?.tagline || "High-performance NVMe cloud hosting with isolated execution environments and automated daily snapshots."}
              </p>
            </div>
            <div className="text-left sm:text-right shrink-0">
              <div className="text-3xl font-black text-cyan-300">
                ₹{myPlan.price_cents / 100}
                <span className="text-xs text-slate-400 font-normal"> /month</span>
              </div>
              <span className="inline-block mt-1 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                ● Active Subscription
              </span>
            </div>
          </div>

          {/* Quota Usage Meters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 bg-slate-800/80 rounded-xl border border-slate-700/80">
              <div className="text-xs text-slate-400 font-medium">Websites Hosted</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-white">{usage.websites}</span>
                <span className="text-xs text-slate-400">
                  / {myPlan.max_websites >= 999 ? "Unlimited" : myPlan.max_websites} allowed
                </span>
              </div>
              <div className="mt-2 w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-cyan-400 h-1.5 rounded-full"
                  style={{
                    width: `${Math.min(100, (usage.websites / (myPlan.max_websites >= 999 ? 50 : myPlan.max_websites)) * 100)}%`,
                  }}
                ></div>
              </div>
            </div>

            <div className="p-4 bg-slate-800/80 rounded-xl border border-slate-700/80">
              <div className="text-xs text-slate-400 font-medium">Pure NVMe SSD Storage</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-white">
                  {myPlan.max_storage_mb >= 1024 ? `${myPlan.max_storage_mb / 1024} GB` : `${myPlan.max_storage_mb} MB`}
                </span>
                <span className="text-xs text-slate-400">allocated</span>
              </div>
              <div className="mt-2 w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                <div className="bg-emerald-400 h-1.5 rounded-full" style={{ width: "15%" }}></div>
              </div>
            </div>

            <div className="p-4 bg-slate-800/80 rounded-xl border border-slate-700/80">
              <div className="text-xs text-slate-400 font-medium">MySQL Databases</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-white">{usage.databases}</span>
                <span className="text-xs text-slate-400">
                  / {myPlan.max_databases >= 999 ? "Unlimited" : myPlan.max_databases} allowed
                </span>
              </div>
              <div className="mt-2 w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-cyan-400 h-1.5 rounded-full"
                  style={{
                    width: `${Math.min(100, (usage.databases / (myPlan.max_databases >= 999 ? 50 : myPlan.max_databases)) * 100)}%`,
                  }}
                ></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PLANS DISPLAY GRID */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {isAdmin ? "Present Hosting Packages" : "Available Plans & Upgrades"}
            </h2>
            <p className="text-xs text-slate-500">
              {isAdmin
                ? "Click 'Edit Plan' on any card to update its storage, website limits, pricing, or feature bullets."
                : "Explore our cloud hosting tiers. To upgrade or modify your package, contact support."}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((p: any) => {
            const { tagline, badge, features } = parsePlanDetails(p);
            const isCurrentCustomerPlan = customerAccount?.plan_id === p.id;
            const isMostPopular = badge?.toUpperCase().includes("POPULAR") || p.slug === "business-pro";
            const subscriberCount = planSubscriberMap[p.id] || 0;

            return (
              <div
                key={p.id}
                className={`relative flex flex-col bg-white rounded-3xl transition-all duration-200 border ${
                  isMostPopular
                    ? "border-rose-400 shadow-lg ring-2 ring-rose-400/20"
                    : isCurrentCustomerPlan
                    ? "border-cyan-500 shadow-md ring-2 ring-cyan-500/20"
                    : "border-slate-200 shadow-xs hover:shadow-md"
                }`}
              >
                {/* Popular / Custom Badge Ribbon */}
                {badge && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span
                      className={`px-3.5 py-1 text-[11px] font-extrabold uppercase tracking-wider rounded-full shadow-xs text-white ${
                        isMostPopular
                          ? "bg-gradient-to-r from-rose-500 to-pink-600"
                          : "bg-gradient-to-r from-cyan-600 to-blue-600"
                      }`}
                    >
                      {badge}
                    </span>
                  </div>
                )}

                <div className="p-6 pb-4 border-b border-slate-100 flex-1">
                  <div className="flex items-start justify-between gap-2 mt-2">
                    <div>
                      <h3 className="text-xl font-extrabold text-slate-900">{p.name}</h3>
                      <p className="text-xs text-slate-500 mt-1 min-h-[36px]">{tagline}</p>
                    </div>
                  </div>

                  {/* Price */}
                  <div className="mt-4 flex items-baseline">
                    <span className="text-4xl font-black tracking-tight text-slate-900">
                      ₹{p.price_cents / 100}
                    </span>
                    <span className="text-xs font-semibold text-slate-500 ml-1.5">/month</span>
                  </div>

                  <div className="mt-2 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200 inline-block">
                    {p.price_cents === 4900
                      ? "Billed annually or ₹99/mo monthly"
                      : p.price_cents === 9900
                      ? "Best Value • High-Speed NVMe SSD"
                      : "Unlimited Domains & Extra Storage"}
                  </div>

                  {/* Quotas Summary Pill */}
                  <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-medium">Websites:</span>
                      <span className="font-bold text-slate-900">
                        {p.max_websites >= 999 ? "Host Unlimited Websites" : `Up to ${p.max_websites} Websites`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-medium">NVMe SSD Space:</span>
                      <span className="font-bold text-cyan-800">
                        {p.max_storage_mb >= 1024 ? `${p.max_storage_mb / 1024} GB Space` : `${p.max_storage_mb} MB Space`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-medium">MySQL Databases:</span>
                      <span className="font-bold text-slate-900">
                        {p.max_databases >= 999 ? "Unlimited Databases" : `${p.max_databases} Dedicated DB${p.max_databases > 1 ? "s" : ""}`}
                      </span>
                    </div>
                  </div>

                  {/* Features List */}
                  <ul className="mt-5 space-y-2.5 text-xs text-slate-600">
                    {features.map((feat: string, idx: number) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-emerald-500 font-bold shrink-0 text-sm">✓</span>
                        <span className="font-medium text-slate-700">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Card Footer */}
                <div className="p-4 bg-slate-50/70 rounded-b-3xl border-t border-slate-100 flex items-center justify-between gap-2">
                  {isAdmin ? (
                    <>
                      <span className="text-xs text-slate-500 font-mono">
                        {subscriberCount} subscriber{subscriberCount === 1 ? "" : "s"}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingPlan(p)}
                          className="px-3 py-1.5 text-xs font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
                        >
                          ✏️ Edit Plan
                        </button>
                        <Form
                          method="POST"
                          onSubmit={(e) => {
                            if (!confirm(`Are you sure you want to remove or deactivate plan "${p.name}"?`)) {
                              e.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="intent" value="delete_plan" />
                          <input type="hidden" name="plan_id" value={p.id} />
                          <button
                            type="submit"
                            className="px-2.5 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition"
                            title="Delete or Deactivate Plan"
                          >
                            🗑️
                          </button>
                        </Form>
                      </div>
                    </>
                  ) : (
                    <div className="w-full">
                      {isCurrentCustomerPlan ? (
                        <div className="w-full py-2 text-center text-xs font-bold text-cyan-800 bg-cyan-100/70 rounded-xl border border-cyan-200">
                          ✓ Current Subscribed Plan
                        </div>
                      ) : (
                        <a
                          href="/dashboard/support"
                          className="block w-full py-2 text-center text-xs font-bold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-50 transition shadow-xs"
                        >
                          Request Upgrade ↗
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* INVOICES & BILLING HISTORY */}
      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-sm text-slate-800">Billing & Payment Invoices</h3>
          <span className="text-xs text-slate-400">{invoices.length} total invoice records</span>
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
                      ₹{(inv.amount_cents / 100).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-500">
                      {formatDate(inv.due_date)}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full ${
                          inv.status === "paid"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
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

      {/* ADD PLAN MODAL (ADMIN ONLY) */}
      {isAddPlanModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-xl p-6 bg-white rounded-2xl shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Add New Hosting Plan</h2>
                <p className="text-xs text-slate-500">Create a new pricing tier with custom quotas and features</p>
              </div>
              <button
                onClick={() => setIsAddPlanModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setIsAddPlanModalOpen(false)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="create_plan" />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField
                  id="name"
                  name="name"
                  label="Plan Name"
                  type="text"
                  required
                  placeholder="e.g. Enterprise Cloud"
                />
                <TextField
                  id="slug"
                  name="slug"
                  label="URL Slug (Optional)"
                  type="text"
                  placeholder="e.g. enterprise-cloud"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField
                  id="price_rupees"
                  name="price_rupees"
                  label="Price (₹ INR / month)"
                  type="number"
                  required
                  defaultValue="99"
                  placeholder="99"
                />
                <TextField
                  id="badge"
                  name="badge"
                  label="Badge / Ribbon (Optional)"
                  type="text"
                  placeholder="e.g. MOST POPULAR, BEST VALUE"
                />
              </div>

              <TextField
                id="tagline"
                name="tagline"
                label="Tagline / Brief Subtitle"
                type="text"
                placeholder="Best value for small businesses and developers"
              />

              {/* Quotas */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Max Websites
                  </label>
                  <input
                    type="number"
                    name="max_websites"
                    value={addWebsites}
                    onChange={(e) => setAddWebsites(parseInt(e.target.value) || 1)}
                    required
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <div className="flex gap-1 mt-1 text-[10px]">
                    <button type="button" onClick={() => setAddWebsites(1)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">1</button>
                    <button type="button" onClick={() => setAddWebsites(10)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">10</button>
                    <button type="button" onClick={() => setAddWebsites(999)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">Unlimited</button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    NVMe Storage (MB)
                  </label>
                  <input
                    type="number"
                    name="max_storage_mb"
                    value={addStorageMb}
                    onChange={(e) => setAddStorageMb(parseInt(e.target.value) || 300)}
                    required
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <div className="flex gap-1 mt-1 text-[10px]">
                    <button type="button" onClick={() => setAddStorageMb(300)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">300MB</button>
                    <button type="button" onClick={() => setAddStorageMb(1024)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">1GB</button>
                    <button type="button" onClick={() => setAddStorageMb(5120)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">5GB</button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    MySQL Databases
                  </label>
                  <input
                    type="number"
                    name="max_databases"
                    value={addDatabases}
                    onChange={(e) => setAddDatabases(parseInt(e.target.value) || 1)}
                    required
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <div className="flex gap-1 mt-1 text-[10px]">
                    <button type="button" onClick={() => setAddDatabases(1)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">1</button>
                    <button type="button" onClick={() => setAddDatabases(10)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">10</button>
                    <button type="button" onClick={() => setAddDatabases(999)} className="px-1.5 py-0.5 bg-slate-100 rounded hover:bg-slate-200">Unlimited</button>
                  </div>
                </div>
              </div>

              {/* Features list */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Features & Inclusions (1 per line)
                </label>
                <textarea
                  name="features"
                  rows={5}
                  defaultValue={`1 Dedicated cPanel Account\nUnlimited Monthly Bandwidth\nFree Auto-SSL Certificate\nFree 1-click app installer\n1 Dedicated vCPU & 1GB RAM\n99.9% Cloud Uptime SLA`}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Enter each feature on a new line"
                ></textarea>
                <p className="mt-1 text-[11px] text-slate-400">
                  Each line will appear with a green checkmark on the customer pricing card.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setIsAddPlanModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Save & Publish Plan
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* EDIT PLAN MODAL (ADMIN ONLY) */}
      {editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-xl p-6 bg-white rounded-2xl shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Edit Hosting Plan</h2>
                <p className="text-xs text-slate-500">Update pricing, storage quotas, and feature descriptions for {editingPlan.name}</p>
              </div>
              <button
                onClick={() => setEditingPlan(null)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setEditingPlan(null)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="edit_plan" />
              <input type="hidden" name="plan_id" value={editingPlan.id} />

              {(() => {
                const { tagline, badge, features } = parsePlanDetails(editingPlan);
                return (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <TextField
                        id="edit_name"
                        name="name"
                        label="Plan Name"
                        type="text"
                        required
                        defaultValue={editingPlan.name}
                      />
                      <TextField
                        id="edit_price"
                        name="price_rupees"
                        label="Price (₹ INR / month)"
                        type="number"
                        required
                        defaultValue={String(editingPlan.price_cents / 100)}
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <TextField
                        id="edit_tagline"
                        name="tagline"
                        label="Tagline / Description"
                        type="text"
                        defaultValue={tagline}
                      />
                      <TextField
                        id="edit_badge"
                        name="badge"
                        label="Badge / Ribbon (e.g. MOST POPULAR)"
                        type="text"
                        defaultValue={badge}
                      />
                    </div>

                    {/* Quotas */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-700 mb-1">
                          Max Websites
                        </label>
                        <input
                          type="number"
                          name="max_websites"
                          defaultValue={editingPlan.max_websites}
                          required
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                        <span className="text-[10px] text-slate-400">999 = Unlimited</span>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-700 mb-1">
                          NVMe Storage (MB)
                        </label>
                        <input
                          type="number"
                          name="max_storage_mb"
                          defaultValue={editingPlan.max_storage_mb}
                          required
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                        <span className="text-[10px] text-slate-400">300, 1024 (1GB), 5120 (5GB)</span>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-700 mb-1">
                          MySQL Databases
                        </label>
                        <input
                          type="number"
                          name="max_databases"
                          defaultValue={editingPlan.max_databases}
                          required
                          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                        <span className="text-[10px] text-slate-400">999 = Unlimited</span>
                      </div>
                    </div>

                    {/* Features list */}
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Features & Inclusions (1 per line)
                      </label>
                      <textarea
                        name="features"
                        rows={6}
                        defaultValue={features.join("\n")}
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      ></textarea>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="is_active"
                        name="is_active"
                        value="true"
                        defaultChecked={editingPlan.is_active}
                        className="rounded text-cyan-600 focus:ring-cyan-500"
                      />
                      <label htmlFor="is_active" className="text-sm font-medium text-slate-700">
                        Plan is Active and available for assignment
                      </label>
                    </div>
                  </>
                );
              })()}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setEditingPlan(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Save Plan Changes
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
