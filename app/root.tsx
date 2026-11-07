import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "@remix-run/react";
import type { LinksFunction } from "@remix-run/node";

import styles from "~/styles/tailwind.css?url";
import GlobalPreloader from "~/components/GlobalPreloader";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: styles },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              /* Prevent SVG Flash of Unstyled Content (FOUC) before external CSS runs */
              svg {
                display: inline-block;
                max-width: 100%;
                vertical-align: middle;
              }
              .w-3\\.5 { width: 0.875rem !important; height: 0.875rem !important; }
              .w-4 { width: 1rem !important; height: 1rem !important; }
              .w-5 { width: 1.25rem !important; height: 1.25rem !important; }
              .w-6 { width: 1.5rem !important; height: 1.5rem !important; }
              .w-7 { width: 1.75rem !important; height: 1.75rem !important; }
              .w-8 { width: 2rem !important; height: 2rem !important; }
              .w-10 { width: 2.5rem !important; height: 2.5rem !important; }
            `,
          }}
        />
        <Links />
      </head>
      <body className="flex flex-col min-h-screen text-slate-700 bg-slate-100">
        <GlobalPreloader />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let errorMessage = "An unexpected error occurred.";
  let errorStatus = 500;
  if (isRouteErrorResponse(error)) {
    errorStatus = error.status;
    errorMessage = `${error.status} ${error.statusText}: ${typeof error.data === "string" ? error.data : JSON.stringify(error.data)}`;
  } else if (error instanceof Error) {
    errorMessage = error.message;
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>DDL Group Hosting Panel</title>
        <Links />
      </head>
      <body className="flex flex-col min-h-screen items-center justify-center p-6 bg-slate-900 text-slate-100">
        <div className="w-full max-w-lg bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-3 text-cyan-400">
            <span className="text-2xl">⚡</span>
            <div>
              <h1 className="text-lg font-bold text-white">DDL Group Hosting Panel</h1>
              <p className="text-xs text-slate-400">Error Status: {errorStatus}</p>
            </div>
          </div>
          <div className="p-3 bg-slate-900/80 border border-slate-700 rounded-xl text-xs font-mono text-rose-300 break-words whitespace-pre-wrap">
            {errorMessage}
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs font-bold text-slate-900 bg-cyan-400 rounded-xl hover:bg-cyan-300 transition"
            >
              🔄 Reload Page
            </button>
            <a
              href="/dashboard"
              className="px-4 py-2 text-xs font-bold text-white bg-slate-700 rounded-xl hover:bg-slate-600 transition"
            >
              Go to Dashboard
            </a>
          </div>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
