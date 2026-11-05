import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import Button from "~/components/Button";
import TextField from "~/components/TextField";
import { createUserSession, getSession } from "~/session.server";
import { getCsrfToken, validateCsrfToken } from "~/utils/csrf.server";
import { getSupabaseAdminClient, getSupabaseClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Sign In | DDL Group Hosting Panel" },
    { name: "description", content: "Sign in to DDL Group Hosting Management Panel" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  const token = session.get("__session");

  if (token) {
    try {
      const supabase = getSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        return redirect("/dashboard");
      }
    } catch {
      // Token expired, allow view login
    }
  }

  const { csrfToken, cookieHeader } = await getCsrfToken(request);

  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  let defaultError = "";
  if (errorParam === "account_suspended") {
    defaultError = "Your hosting account is currently suspended. Please contact DDL Group administration.";
  }

  return Response.json(
    { csrfToken, defaultError },
    {
      headers: cookieHeader ? { "Set-Cookie": cookieHeader } : undefined,
    }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();

  const isCsrfValid = await validateCsrfToken(request, formData);
  if (!isCsrfValid) {
    return Response.json({ error: "Security validation failed. Please refresh the page and try again." }, { status: 403 });
  }

  const email = formData.get("email");
  const password = formData.get("password");

  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return Response.json({ error: "Please enter your email and password." }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error || !data.session) {
    return Response.json({ error: "Invalid email or password. Please verify your credentials." }, { status: 401 });
  }

  // Check account suspension status in user_profiles
  const supabaseAdmin = getSupabaseAdminClient();
  const { data: profile } = await supabaseAdmin
    .from("user_profiles")
    .select("status, role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile && profile.status === "suspended") {
    return Response.json(
      { error: "Your account is currently suspended. Please contact your DDL Group administrator." },
      { status: 403 }
    );
  }

  return createUserSession(
    data.session.access_token,
    data.session.refresh_token,
    data.user.id,
    "/dashboard"
  );
}

export default function LogIn() {
  const { csrfToken, defaultError } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const errorMessage = actionData?.error || defaultError;

  return (
    <div className="w-full max-w-md p-8 bg-white border border-slate-200 shadow-xl rounded-2xl">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 text-white shadow-md shadow-cyan-500/20">
          <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          DDL GROUP HOSTING
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Sign in to access your hosting control panel
        </p>
      </div>

      {errorMessage && (
        <div className="p-3 mb-6 text-sm font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg">
          {errorMessage}
        </div>
      )}

      <Form method="POST" className="space-y-5">
        <input type="hidden" name="csrf_token" value={csrfToken} />

        <TextField
          id="email"
          name="email"
          label="Account Email"
          type="email"
          required
          autoComplete="email"
          placeholder="your.email@example.com"
        />

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="password" className="block text-sm font-medium text-slate-700">
              Password
            </label>
            <Link
              to="/reset-password"
              className="text-xs font-semibold text-cyan-600 hover:text-cyan-700 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <TextField
            id="password"
            name="password"
            label=""
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••••••"
          />
        </div>

        <Button type="submit" className="w-full py-2.5 font-semibold text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg shadow-sm" loading={isSubmitting}>
          Sign In to Panel
        </Button>
      </Form>

      <div className="pt-6 mt-6 border-t border-slate-100 text-center text-xs text-slate-400">
        Digital Design Leadership Group &bull; Secure Hosting Infrastructure
      </div>
    </div>
  );
}
