import { redirect } from "@remix-run/node";
import { commitSession, destroySession, getSession } from "~/session.server";
import { getSupabaseAdminClient, getSupabaseClient } from "./supabase.server";

export type UserRole =
  | "super_admin"
  | "staff_admin"
  | "technical_staff"
  | "support_staff"
  | "customer";

export type UserStatus = "active" | "suspended" | "pending";

export type UserProfile = {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
};

/**
 * Validates the current session token with Supabase Auth.
 * Attempts token refresh if access token is expired.
 */
export async function requireUserSession(request: Request) {
  const session = await getSession(request.headers.get("Cookie"));
  const accessToken = session.get("__session");
  const refreshToken = session.get("__refresh_token");

  if (!accessToken || typeof accessToken !== "string") {
    throw redirect("/login");
  }

  const supabase = getSupabaseClient(accessToken);
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);

  if (user && !error) {
    return { user, accessToken, session };
  }

  // If token is invalid or expired, attempt refresh
  if (refreshToken && typeof refreshToken === "string") {
    try {
      const anonClient = getSupabaseClient();
      const { data: refreshData, error: refreshError } = await anonClient.auth.refreshSession({
        refresh_token: refreshToken,
      });

      if (refreshData?.session && !refreshError) {
        session.set("__session", refreshData.session.access_token);
        session.set("__refresh_token", refreshData.session.refresh_token);

        // Redirect to refresh the cookie in browser
        throw redirect(request.url, {
          headers: {
            "Set-Cookie": await commitSession(session),
          },
        });
      }
    } catch (e) {
      if (e instanceof Response) throw e;
    }
  }

  // Auth failed - clear session
  throw redirect("/login", {
    headers: {
      "Set-Cookie": await destroySession(session),
    },
  });
}

/**
 * Validates session and fetches the database user_profile.
 * Strictly verifies account is active.
 */
export async function requireUserProfile(request: Request): Promise<{
  user: any;
  profile: UserProfile;
  accessToken: string;
}> {
  const { user, accessToken, session } = await requireUserSession(request);

  const supabaseAdmin = getSupabaseAdminClient();
  const { data: profile, error } = await supabaseAdmin
    .from("user_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !profile) {
    console.error("Profile not found for authenticated user:", user.id, error?.message);
    throw redirect("/login", {
      headers: {
        "Set-Cookie": await destroySession(session),
      },
    });
  }

  if (profile.status === "suspended") {
    throw redirect("/login?error=account_suspended", {
      headers: {
        "Set-Cookie": await destroySession(session),
      },
    });
  }

  return {
    user,
    profile: {
      ...profile,
      email: user.email || profile.email || "",
    },
    accessToken,
  };
}

/**
 * Enforce role-based access control.
 */
export async function requireRole(
  request: Request,
  allowedRoles: UserRole[]
): Promise<{ user: any; profile: UserProfile; accessToken: string }> {
  const { user, profile, accessToken } = await requireUserProfile(request);

  if (!allowedRoles.includes(profile.role)) {
    throw new Response("Forbidden: You do not have permission to access this resource.", {
      status: 403,
      statusText: "Forbidden",
    });
  }

  return { user, profile, accessToken };
}

/**
 * Records an action in the audit_logs table.
 */
export async function logAuditEvent(
  actorId: string,
  action: string,
  targetType: string,
  targetId?: string | null,
  details?: Record<string, any>
) {
  try {
    const supabaseAdmin = getSupabaseAdminClient();
    await supabaseAdmin.from("audit_logs").insert({
      actor_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId || null,
      details: details || {},
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("Failed to write audit log:", err);
  }
}
