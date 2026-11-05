import { createCookieSessionStorage, redirect } from "@remix-run/node";

const sessionSecret = process.env.SESSION_SECRET || "fallback-secret-for-build-and-testing-32-chars-min";

if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.warn("WARNING: SESSION_SECRET is missing or too short for production.");
}

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__ddl_session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [sessionSecret],
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
});

export const { getSession, commitSession, destroySession } = sessionStorage;

export async function createUserSession(
  accessToken: string,
  refreshToken: string | undefined,
  userId: string,
  redirectTo: string = "/dashboard"
) {
  const session = await getSession();
  session.set("__session", accessToken);
  if (refreshToken) {
    session.set("__refresh_token", refreshToken);
  }
  session.set("__user_id", userId);

  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}

export async function destroyUserSession(request: Request, redirectTo: string = "/login") {
  const session = await getSession(request.headers.get("Cookie"));
  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await destroySession(session),
    },
  });
}
