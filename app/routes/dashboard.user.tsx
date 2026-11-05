import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { requireUserProfile } from "~/utils/auth.server";
import { formatDate } from "~/utils/formatDate";
import { getSupabaseClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "User Profile | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, profile } = await requireUserProfile(request);
  return Response.json({ user, profile });
}

export async function action({ request }: ActionFunctionArgs) {
  const { user, accessToken } = await requireUserProfile(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_password") {
    const newPassword = formData.get("new_password");
    const confirmPassword = formData.get("confirm_password");

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters long." }, { status: 400 });
    }

    if (newPassword !== confirmPassword) {
      return Response.json({ error: "Passwords do not match." }, { status: 400 });
    }

    const supabase = getSupabaseClient(accessToken);
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: "Password successfully updated." });
  }

  return Response.json({ error: "Invalid action." }, { status: 400 });
}

export default function User() {
  const { profile } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const initials = profile.full_name
    ? profile.full_name.split(" ").map((n: string) => n[0]).slice(0, 2).join("").toUpperCase()
    : "US";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Account Profile
        </h1>
        <p className="text-sm text-slate-500">
          Manage your personal account credentials and security settings
        </p>
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

      {/* Profile Details Card */}
      <div className="p-6 bg-white border border-slate-200 shadow-xs rounded-2xl">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 pb-6 border-b border-slate-100">
          <div className="flex items-center justify-center w-16 h-16 font-bold text-white rounded-2xl bg-gradient-to-tr from-cyan-600 to-slate-800 text-xl shadow-md">
            {initials}
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-slate-900">{profile.full_name}</h2>
            <p className="text-sm text-slate-500">{profile.email}</p>
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-block px-2.5 py-0.5 text-xs font-bold uppercase rounded-md bg-purple-100 text-purple-700 border border-purple-200">
                {profile.role.replace("_", " ")}
              </span>
              <span className="inline-block px-2.5 py-0.5 text-xs font-bold uppercase rounded-md bg-emerald-100 text-emerald-700 border border-emerald-200">
                {profile.status}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase">User ID</label>
            <p className="mt-1 font-mono text-xs text-slate-700 bg-slate-50 p-2 rounded-lg border border-slate-200 break-all">
              {profile.id}
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase">Member Since</label>
            <p className="mt-1 font-medium text-slate-800 p-2">
              {formatDate(profile.created_at)}
            </p>
          </div>
        </div>
      </div>

      {/* Security: Change Password Card */}
      <div className="p-6 bg-white border border-slate-200 shadow-xs rounded-2xl">
        <h3 className="text-lg font-bold text-slate-900 mb-1">Update Security Credentials</h3>
        <p className="text-sm text-slate-500 mb-6">Change your hosting account password</p>

        <Form method="POST" className="max-w-md space-y-4">
          <input type="hidden" name="intent" value="update_password" />

          <TextField
            id="new_password"
            name="new_password"
            label="New Password"
            type="password"
            required
            placeholder="At least 8 characters"
          />

          <TextField
            id="confirm_password"
            name="confirm_password"
            label="Confirm New Password"
            type="password"
            required
            placeholder="Re-enter new password"
          />

          <Button type="submit" loading={isSubmitting} className="font-semibold text-white bg-cyan-600 hover:bg-cyan-700">
            Save Password
          </Button>
        </Form>
      </div>
    </div>
  );
}
