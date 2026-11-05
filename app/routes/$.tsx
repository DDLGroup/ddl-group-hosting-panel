import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { handleCustomDomainRequest } from "~/utils/websiteDeployer.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const rawPath = params["*"] || "";

  // Check if request is from a mapped custom domain (e.g. test.ddlg.in/styles.css)
  const customDomainResponse = await handleCustomDomainRequest(request, rawPath);
  if (customDomainResponse) {
    return customDomainResponse;
  }

  return Response.json({});
}

export default function CatchAllNotFound() {
  return (
    <main className="grow px-8 py-16 flex items-center justify-center">
      <div className="p-8 max-w-lg bg-white border border-slate-200 rounded-2xl shadow-xl text-center space-y-4">
        <h1 className="text-3xl font-extrabold text-slate-900">
          Page Not Found
        </h1>
        <p className="text-sm text-slate-500">
          The requested route or resource does not exist.
        </p>
        <Link
          to="/"
          className="inline-block px-4 py-2 text-sm font-semibold text-white bg-cyan-600 rounded-xl hover:bg-cyan-700 transition"
        >
          Return to Dashboard
        </Link>
      </div>
    </main>
  );
}
