import type { LoaderFunctionArgs } from "@remix-run/node";
import { serveCloudWebsiteFile } from "~/utils/websiteDeployer.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const subdomain = params.subdomain;
  const rawPath = params["*"] || "index.html";

  if (!subdomain) {
    return new Response("Invalid website subdomain.", { status: 400 });
  }

  return serveCloudWebsiteFile(subdomain, rawPath);
}
