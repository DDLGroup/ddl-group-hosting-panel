import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
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
