
import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import { getSession } from "~/session.server";
import { getSupabaseClient } from "~/utils/getSupabaseClient";

function isValidMemberId(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  const accessToken = session.get("__session");

  if (!accessToken || typeof accessToken !== "string") {
    throw redirect("/login");
  }

  const memberId = params.memberId;

  if (!memberId || !isValidMemberId(memberId)) {
    throw new Response("Invalid member ID.", { status: 400 });
  }

  const supabase = getSupabaseClient(accessToken);

  const { data, error } = await supabase
    .from("members")
    .delete()
    .eq("id", memberId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("Member deletion failed:", error.message);
    throw new Response("Unable to delete member.", { status: 500 });
  }

  if (!data) {
    throw new Response("Member not found or access denied.", {
      status: 404,
    });
  }

  return redirect("/dashboard");
}
