import type { LoaderFunctionArgs } from "@remix-run/node";
import { getMimeType } from "~/utils/websiteDeployer.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const subdomain = params.subdomain;
  let rawPath = params["*"] || "index.html";

  if (!subdomain) {
    return new Response("Invalid website subdomain.", { status: 400 });
  }

  if (rawPath === "" || rawPath.endsWith("/")) {
    rawPath += "index.html";
  }

  const supabaseAdmin = getSupabaseAdminClient();

  // 1. Attempt to download the requested file
  let { data: fileBlob, error } = await supabaseAdmin.storage
    .from("client-websites")
    .download(`${subdomain}/${rawPath}`);

  // 2. If not found and doesn't have an extension, try appending .html or /index.html
  if (error || !fileBlob) {
    if (!rawPath.includes(".")) {
      const fallbackResult = await supabaseAdmin.storage
        .from("client-websites")
        .download(`${subdomain}/${rawPath}/index.html`);

      if (!fallbackResult.error && fallbackResult.data) {
        fileBlob = fallbackResult.data;
        rawPath += "/index.html";
        error = null;
      } else {
        const htmlFallback = await supabaseAdmin.storage
          .from("client-websites")
          .download(`${subdomain}/${rawPath}.html`);

        if (!htmlFallback.error && htmlFallback.data) {
          fileBlob = htmlFallback.data;
          rawPath += ".html";
          error = null;
        }
      }
    }
  }

  if (error || !fileBlob) {
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <title>404 Not Found | DDL Group Hosting</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { text-align: center; max-width: 480px; padding: 2rem; background: #1e293b; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #334155; }
    h1 { font-size: 2.5rem; margin: 0 0 0.5rem; color: #38bdf8; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .badge { font-size: 0.75rem; text-transform: uppercase; font-weight: bold; background: #0284c7; padding: 0.25rem 0.75rem; border-radius: 9999px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">DDL Group Cloud Hosting</span>
    <h1>404 Not Found</h1>
    <p>The requested file (<code>${rawPath}</code>) does not exist on website <strong>${subdomain}</strong>.</p>
    <p>Please upload your website files (including <code>index.html</code>) in the DDL Group Hosting Panel File Manager.</p>
  </div>
</body>
</html>`,
      {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      }
    );
  }

  const arrayBuffer = await fileBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = getMimeType(rawPath);

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
      "X-Powered-By": "DDL Group Cloud Hosting Engine",
    },
  });
}
