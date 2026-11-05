import type { LoaderFunctionArgs } from "@remix-run/node";
import { handleCustomDomainRequest } from "~/utils/websiteDeployer.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const rawPath = params["*"] || "";

  // 1. Check if request is from a mapped custom domain (e.g. test.advjagadish.in/styles.css)
  const customDomainResponse = await handleCustomDomainRequest(request, rawPath);
  if (customDomainResponse) {
    return customDomainResponse;
  }

  // 2. Fallback 404 for non-existent panel routes
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <title>404 Not Found | DDL Group Hosting</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { text-align: center; max-width: 480px; padding: 2.5rem; background: #1e293b; border-radius: 1rem; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
    h1 { font-size: 2.5rem; margin: 0 0 0.5rem; color: #38bdf8; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    a { display: inline-block; padding: 0.65rem 1.5rem; background: #0284c7; color: white; border-radius: 0.75rem; text-decoration: none; font-weight: bold; font-size: 0.85rem; }
    a:hover { background: #0369a1; }
  </style>
</head>
<body>
  <div class="card">
    <h1>404 Not Found</h1>
    <p>The requested page or resource could not be found.</p>
    <a href="/dashboard">Return to Dashboard</a>
  </div>
</body>
</html>`,
    {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}
