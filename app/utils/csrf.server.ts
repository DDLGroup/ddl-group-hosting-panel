import crypto from "crypto";
import { commitSession, getSession } from "~/session.server";

export async function getCsrfToken(request: Request): Promise<{ csrfToken: string; cookieHeader?: string }> {
  const session = await getSession(request.headers.get("Cookie"));
  let csrfToken = session.get("__csrf_token");

  if (!csrfToken || typeof csrfToken !== "string") {
    csrfToken = crypto.randomBytes(24).toString("hex");
    session.set("__csrf_token", csrfToken);
    return {
      csrfToken,
      cookieHeader: await commitSession(session),
    };
  }

  return { csrfToken };
}

export async function validateCsrfToken(request: Request, formData: FormData): Promise<boolean> {
  const session = await getSession(request.headers.get("Cookie"));
  const sessionToken = session.get("__csrf_token");
  const formToken = formData.get("csrf_token");

  if (!sessionToken || !formToken || sessionToken !== formToken) {
    return false;
  }

  return true;
}
