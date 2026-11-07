import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { logAuditEvent, requireRole, type UserProfile, type UserRole } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "User Management | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Only super_admin and staff_admin can access User Management
  await requireRole(request, ["super_admin", "staff_admin"]);

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.toLowerCase() || "";
  const roleFilter = url.searchParams.get("role") || "all";
  const statusFilter = url.searchParams.get("status") || "all";

  const supabaseAdmin = getSupabaseAdminClient();

  // Fetch all profiles
  let query = supabaseAdmin
    .from("user_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (roleFilter !== "all") {
    query = query.eq("role", roleFilter);
  }

  if (statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data: profiles, error } = await query;

  if (error) {
    throw new Response(error.message, { status: 500 });
  }

  // Also fetch auth users to get emails
  const { data: authData } = await supabaseAdmin.auth.admin.listUsers();
  const emailMap = new Map<string, string>();
  if (authData?.users) {
    for (const u of authData.users) {
      if (u.email) emailMap.set(u.id, u.email);
    }
  }

  // Fetch all hosting plans
  const { data: plans } = await supabaseAdmin
    .from("hosting_plans")
    .select("*")
    .order("price_cents", { ascending: true });

  // Fetch customer hosting accounts to see who is on what plan
  const { data: accounts } = await supabaseAdmin
    .from("hosting_accounts")
    .select("customer_id, plan_id, hosting_plans(id, name, slug, price_cents, max_websites, max_storage_mb, max_databases)");

  const userPlanMap = new Map<string, any>();
  if (accounts) {
    for (const acc of accounts) {
      if (acc.customer_id) {
        userPlanMap.set(acc.customer_id, acc.hosting_plans);
      }
    }
  }

  const enrichedUsers = (profiles || []).map((p) => ({
    ...p,
    email: emailMap.get(p.id) || p.email || "No email",
    plan: userPlanMap.get(p.id) || null,
  }));

  const filteredUsers = search
    ? enrichedUsers.filter(
        (u) =>
          u.full_name.toLowerCase().includes(search) ||
          u.email.toLowerCase().includes(search)
      )
    : enrichedUsers;

  return Response.json({ users: filteredUsers, plans: plans || [] });
}

export async function action({ request }: ActionFunctionArgs) {
  const { profile: actorProfile } = await requireRole(request, ["super_admin", "staff_admin"]);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const supabaseAdmin = getSupabaseAdminClient();

  // 1. Create New User
  if (intent === "create_user") {
    const fullName = formData.get("full_name");
    const email = formData.get("email");
    const password = formData.get("password");
    const role = formData.get("role") as UserRole;
    const planId = formData.get("plan_id") as string;

    if (
      typeof fullName !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !fullName.trim() ||
      !email.trim() ||
      password.length < 8
    ) {
      return Response.json({ error: "All fields are required. Password must be at least 8 characters." }, { status: 400 });
    }

    // Non-super-admins cannot create super_admin accounts
    if (role === "super_admin" && actorProfile.role !== "super_admin") {
      return Response.json({ error: "Only Super Admins can provision another Super Admin account." }, { status: 403 });
    }

    // Create user in Supabase Auth via Admin API
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName.trim() },
    });

    if (createError || !newUser?.user) {
      return Response.json({ error: createError?.message || "Failed to create user account." }, { status: 400 });
    }

    // Insert into user_profiles
    const { error: profileError } = await supabaseAdmin.from("user_profiles").insert({
      id: newUser.user.id,
      full_name: fullName.trim(),
      role: role || "customer",
      status: "active",
      created_by: actorProfile.id,
    });

    if (profileError) {
      console.error("Failed to insert user profile:", profileError.message);
    }

    // If customer, assign the selected hosting plan
    if (role === "customer" && planId) {
      await supabaseAdmin.from("hosting_accounts").insert({
        customer_id: newUser.user.id,
        plan_id: planId,
        status: "active",
      });
    }

    await logAuditEvent(
      actorProfile.id,
      "CREATE_USER",
      "user_profiles",
      newUser.user.id,
      { email: email.trim(), role, full_name: fullName.trim(), plan_id: planId }
    );

    return Response.json({ success: "Account successfully created and plan assigned!" });
  }

  // 2. Assign / Change Customer Plan
  if (intent === "assign_plan") {
    const targetUserId = formData.get("user_id") as string;
    const newPlanId = formData.get("plan_id") as string;

    if (!targetUserId || !newPlanId) {
      return Response.json({ error: "User ID and Plan ID are required." }, { status: 400 });
    }

    const { data: existingAccount } = await supabaseAdmin
      .from("hosting_accounts")
      .select("id")
      .eq("customer_id", targetUserId)
      .maybeSingle();

    if (existingAccount) {
      const { error: updateError } = await supabaseAdmin
        .from("hosting_accounts")
        .update({ plan_id: newPlanId, updated_at: new Date().toISOString() })
        .eq("id", existingAccount.id);

      if (updateError) {
        return Response.json({ error: updateError.message }, { status: 500 });
      }
    } else {
      const { error: insertError } = await supabaseAdmin
        .from("hosting_accounts")
        .insert({
          customer_id: targetUserId,
          plan_id: newPlanId,
          status: "active",
        });

      if (insertError) {
        return Response.json({ error: insertError.message }, { status: 500 });
      }
    }

    await logAuditEvent(
      actorProfile.id,
      "ASSIGN_HOSTING_PLAN",
      "hosting_accounts",
      targetUserId,
      { new_plan_id: newPlanId }
    );

    return Response.json({ success: "Customer hosting plan updated successfully!" });
  }

  // 2. Toggle Status (Active / Suspended)
  if (intent === "toggle_status") {
    const targetUserId = formData.get("user_id") as string;
    const currentStatus = formData.get("current_status") as string;

    const newStatus = currentStatus === "active" ? "suspended" : "active";

    // Verify Super Admin safeguard: Never suspend the only Super Admin
    const { data: targetProfile } = await supabaseAdmin
      .from("user_profiles")
      .select("role, status")
      .eq("id", targetUserId)
      .single();

    if (targetProfile?.role === "super_admin" && newStatus === "suspended") {
      const { count } = await supabaseAdmin
        .from("user_profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "super_admin")
        .eq("status", "active");

      if ((count || 0) <= 1) {
        return Response.json({ error: "Security Safeguard: You cannot suspend the only active Super Admin." }, { status: 400 });
      }
    }

    const { error } = await supabaseAdmin
      .from("user_profiles")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", targetUserId);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent(
      actorProfile.id,
      `CHANGE_STATUS_${newStatus.toUpperCase()}`,
      "user_profiles",
      targetUserId,
      { previous: currentStatus, updated: newStatus }
    );

    return Response.json({ success: `User status changed to ${newStatus}.` });
  }

  return Response.json({ error: "Invalid intent." }, { status: 400 });
}

export default function UserManagement() {
  const { users, plans } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [assignPlanUser, setAssignPlanUser] = useState<any>(null);
  const [createRole, setCreateRole] = useState("customer");
  const isSubmitting = navigation.state === "submitting";

  const roleColors: Record<string, string> = {
    super_admin: "bg-purple-100 text-purple-800 border-purple-200",
    staff_admin: "bg-blue-100 text-blue-800 border-blue-200",
    technical_staff: "bg-cyan-100 text-cyan-800 border-cyan-200",
    support_staff: "bg-amber-100 text-amber-800 border-amber-200",
    customer: "bg-emerald-100 text-emerald-800 border-emerald-200",
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            User Management
          </h1>
          <p className="text-sm text-slate-500">
            Manage administrative staff and customer hosting accounts
          </p>
        </div>

        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="inline-flex items-center justify-center px-4 py-2 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 shadow-sm transition"
        >
          + Provision New User
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

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center gap-3 p-4 bg-white border border-slate-200 rounded-2xl shadow-xs">
        <input
          type="text"
          placeholder="Search name or email..."
          defaultValue={searchParams.get("search") || ""}
          onChange={(e) => {
            const val = e.target.value;
            setSearchParams((prev) => {
              if (val) prev.set("search", val);
              else prev.delete("search");
              return prev;
            });
          }}
          className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
        />

        <select
          value={searchParams.get("role") || "all"}
          onChange={(e) => {
            setSearchParams((prev) => {
              prev.set("role", e.target.value);
              return prev;
            });
          }}
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
        >
          <option value="all">All Roles</option>
          <option value="super_admin">Super Admin</option>
          <option value="staff_admin">Staff Admin</option>
          <option value="technical_staff">Technical Staff</option>
          <option value="support_staff">Support Staff</option>
          <option value="customer">Customer</option>
        </select>

        <select
          value={searchParams.get("status") || "all"}
          onChange={(e) => {
            setSearchParams((prev) => {
              prev.set("status", e.target.value);
              return prev;
            });
          }}
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {/* Users Table */}
      <div className="overflow-hidden bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-400 font-semibold text-xs uppercase border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4">User</th>
                <th className="py-3.5 px-4">Role</th>
                <th className="py-3.5 px-4">Hosting Plan</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Created Date</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400">
                    No users found matching your filters.
                  </td>
                </tr>
              ) : (
                users.map((u: any) => (
                  <tr key={u.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900">{u.full_name}</div>
                      <div className="text-xs text-slate-400 font-mono">{u.email}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-block px-2.5 py-0.5 text-xs font-bold uppercase rounded-md border ${roleColors[u.role] || "bg-slate-100"}`}>
                        {u.role.replace("_", " ")}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      {u.role === "customer" ? (
                        u.plan ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1.5 font-bold text-xs text-cyan-800">
                              <span className="w-1.5 h-1.5 rounded-full bg-cyan-500"></span>
                              {u.plan.name}
                            </span>
                            <span className="text-[11px] text-slate-500 font-mono">
                              ₹{u.plan.price_cents / 100}/mo • {u.plan.max_websites >= 999 ? "Unlimited" : `${u.plan.max_websites} Sites`} • {u.plan.max_storage_mb >= 1024 ? `${u.plan.max_storage_mb / 1024}GB` : `${u.plan.max_storage_mb}MB`}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-amber-600 font-medium italic">No Plan Assigned</span>
                        )
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full ${
                        u.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                      }`}>
                        {u.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-500">
                      {formatDate(u.created_at)}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {u.role === "customer" && (
                          <button
                            type="button"
                            onClick={() => setAssignPlanUser(u)}
                            className="text-xs font-semibold px-2.5 py-1 text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 transition"
                            title="Assign or Change Hosting Plan"
                          >
                            📦 Plan
                          </button>
                        )}
                        <Form method="POST" className="inline-block">
                          <input type="hidden" name="intent" value="toggle_status" />
                          <input type="hidden" name="user_id" value={u.id} />
                          <input type="hidden" name="current_status" value={u.status} />
                          <button
                            type="submit"
                            disabled={isSubmitting}
                            className={`text-xs font-semibold px-3 py-1 rounded-lg border transition ${
                              u.status === "active"
                                ? "text-rose-700 bg-rose-50 border-rose-200 hover:bg-rose-100"
                                : "text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
                            }`}
                          >
                            {u.status === "active" ? "Suspend" : "Activate"}
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

      {/* Create User Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-lg p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <h2 className="text-lg font-bold text-slate-900">Provision New User Account</h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setIsCreateModalOpen(false)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="create_user" />

              <TextField
                id="full_name"
                name="full_name"
                label="Full Name"
                type="text"
                required
                placeholder="Jane Smith"
              />

              <TextField
                id="email"
                name="email"
                label="Account Email"
                type="email"
                required
                placeholder="jane@clientwebsite.com"
              />

              <TextField
                id="password"
                name="password"
                label="Initial Password"
                type="password"
                required
                placeholder="At least 8 characters"
              />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Assigned Role
                </label>
                <select
                  name="role"
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="customer">Customer (Website Owner)</option>
                  <option value="support_staff">Support Staff</option>
                  <option value="technical_staff">Technical Staff</option>
                  <option value="staff_admin">Staff Admin</option>
                  <option value="super_admin">Super Admin</option>
                </select>
              </div>

              {/* Plan selector if customer */}
              {createRole === "customer" && (
                <div className="p-3.5 bg-cyan-50/50 border border-cyan-100 rounded-xl space-y-2">
                  <label className="block text-sm font-bold text-slate-800">
                    Assign Hosting Plan
                  </label>
                  <select
                    name="plan_id"
                    defaultValue={plans.find((p: any) => p.slug === "business-pro")?.id || plans[0]?.id}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500 font-medium"
                  >
                    {plans.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — ₹{p.price_cents / 100}/mo ({p.max_websites >= 999 ? "Unlimited" : p.max_websites} Sites, {p.max_storage_mb >= 1024 ? `${p.max_storage_mb / 1024}GB` : `${p.max_storage_mb}MB`} NVMe SSD)
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-500">
                    Customer account will be instantly bound to this plan with its website, database, and storage quotas.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setIsCreateModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Provision Account
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Assign / Change Plan Modal */}
      {assignPlanUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-md p-6 bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Change Hosting Plan</h2>
                <p className="text-xs text-slate-500">{assignPlanUser.full_name} ({assignPlanUser.email})</p>
              </div>
              <button
                onClick={() => setAssignPlanUser(null)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <Form
              method="POST"
              onSubmit={() => setAssignPlanUser(null)}
              className="space-y-4"
            >
              <input type="hidden" name="intent" value="assign_plan" />
              <input type="hidden" name="user_id" value={assignPlanUser.id} />

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Selected Hosting Plan
                </label>
                <select
                  name="plan_id"
                  defaultValue={assignPlanUser.plan?.id || plans[0]?.id}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500 font-medium"
                >
                  {plans.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — ₹{p.price_cents / 100}/mo ({p.max_websites >= 999 ? "Unlimited" : p.max_websites} Sites, {p.max_storage_mb >= 1024 ? `${p.max_storage_mb / 1024}GB` : `${p.max_storage_mb}MB`} NVMe SSD)
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-slate-400">
                  Switching this client's plan dynamically updates their allowed websites, MySQL databases, and SSD storage quota.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => setAssignPlanUser(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting}>
                  Save & Apply Plan
                </Button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
