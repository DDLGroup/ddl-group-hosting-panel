import { createClient } from "@supabase/supabase-js";
import { getSession } from "~/session.server";

const supabaseUrl = process.env.SUPABASE_DATABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Standard Supabase client using Anon/Publishable key.
 * If accessToken is passed, user RLS policies are applied.
 */
export function getSupabaseClient(accessToken?: string) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase environment variables (SUPABASE_DATABASE_URL, SUPABASE_ANON_KEY) are missing.");
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    ...(accessToken
      ? {
          global: {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        }
      : {}),
  });
}

/**
 * Supabase Admin client using Service Role key.
 * STRICTLY SERVER-SIDE ONLY.
 * Bypasses RLS to manage auth users, execute administrative audits, and provision roles.
 */
export function getSupabaseAdminClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_DATABASE_URL is not configured.");
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Get Supabase client authenticated for the current incoming HTTP request.
 */
export async function getAuthenticatedSupabaseClient(request: Request) {
  const session = await getSession(request.headers.get("Cookie"));
  const token = session.get("__session");

  if (!token || typeof token !== "string") {
    return null;
  }

  return getSupabaseClient(token);
}
