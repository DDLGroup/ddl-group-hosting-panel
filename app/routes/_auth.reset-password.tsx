import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { getCsrfToken, validateCsrfToken } from "~/utils/csrf.server";
import { getSupabaseClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Reset Password | DDL Group Hosting Panel" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { csrfToken, cookieHeader } = await getCsrfToken(request);
  return Response.json(
    { csrfToken },
    { headers: cookieHeader ? { "Set-Cookie": cookieHeader } : undefined }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();

  const isCsrfValid = await validateCsrfToken(request, formData);
  if (!isCsrfValid) {
    return Response.json({ error: "Security validation failed. Please refresh the page." }, { status: 403 });
  }

  const email = formData.get("email");
  if (typeof email !== "string" || !email.trim()) {
    return Response.json({ error: "Please provide a valid account email." }, { status: 400 });
  }

  const cleanEmail = email.trim().toLowerCase();
  const origin = new URL(request.url).origin;

  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
    redirectTo: `${origin}/dashboard/user`,
  });

  if (error) {
    console.error("Password reset error:", error.message);
  }

  // Always return success message to prevent user enumeration
  return Response.json({
    success: true,
    message: "If an account exists for that email, password reset instructions have been sent.",
  });
}

export default function ResetPassword() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string; success?: boolean; message?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="w-full max-w-md p-8 bg-white border border-slate-200 shadow-xl rounded-2xl">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-slate-900">
          Reset Password
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Enter your registered email to receive a recovery link
        </p>
      </div>

      {actionData?.error && (
        <div className="p-3 mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
          {actionData.error}
        </div>
      )}

      {actionData?.success ? (
        <div className="space-y-4">
          <div className="p-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
            {actionData.message}
          </div>
          <Link
            to="/login"
            className="block text-center text-sm font-semibold text-cyan-600 hover:text-cyan-700"
          >
            Back to Sign In
          </Link>
        </div>
      ) : (
        <Form method="POST" className="space-y-4">
          <input type="hidden" name="csrf_token" value={csrfToken} />

          <TextField
            id="email"
            name="email"
            label="Account Email"
            type="email"
            required
            autoComplete="email"
            placeholder="admin@ddlgroup.com"
          />

          <Button type="submit" className="w-full py-2.5 font-semibold text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg shadow-sm" loading={isSubmitting}>
            Send Reset Instructions
          </Button>

          <div className="text-center pt-2">
            <Link to="/login" className="text-xs font-semibold text-slate-500 hover:text-slate-800">
              Remember your password? Sign in
            </Link>
          </div>
        </Form>
      )}
    </div>
  );
}
