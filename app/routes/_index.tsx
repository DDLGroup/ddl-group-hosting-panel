import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getSession } from "~/session.server";
import { getSupabaseClient } from "~/utils/supabase.server";
import { handleCustomDomainRequest } from "~/utils/websiteDeployer.server";

export const meta: MetaFunction = () => {
  return [
    { title: "DDL Group Hosting Panel" },
    { name: "description", content: "Professional Web Hosting Management by Digital Design Leadership Group" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  // 1. Check if request came through a custom domain (e.g. test.ddlg.in)
  const customDomainResponse = await handleCustomDomainRequest(request, "index.html");
  if (customDomainResponse) {
    return customDomainResponse;
  }

  // 2. Otherwise, standard panel logic
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
      // Token expired, fallback to login
    }
  }

  return redirect("/login");
}

export default function Index() {
  return null;
}
