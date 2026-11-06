import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { requireUserProfile } from "~/utils/auth.server";
import { getSupabaseAdminClient } from "~/utils/supabase.server";

export const meta: MetaFunction = () => {
  return [{ title: "Overview | DDL Group Hosting Panel" }];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { profile } = await requireUserProfile(request);
  const supabaseAdmin = getSupabaseAdminClient();

  // Load summary metrics
  let websitesQuery = supabaseAdmin.from("hosting_projects").select("id, name, subdomain, runtime, status, created_at");
  let domainsQuery = supabaseAdmin.from("domains").select("id, domain_name, ssl_status, verified");
  let dbQuery = supabaseAdmin.from("databases").select("id, database_name, status");
  let ticketsQuery = supabaseAdmin.from("support_tickets").select("id, ticket_number, subject, status, priority");

  // If customer, filter to own projects
  if (profile.role === "customer") {
    websitesQuery = websitesQuery.eq("customer_id", profile.id);
    domainsQuery = domainsQuery.eq("customer_id", profile.id);
    dbQuery = dbQuery.eq("customer_id", profile.id);
    ticketsQuery = ticketsQuery.eq("customer_id", profile.id);
  }

  const [websitesRes, domainsRes, dbsRes, ticketsRes] = await Promise.all([
    websitesQuery.order("created_at", { ascending: false }).limit(5),
    domainsQuery,
    dbQuery,
    ticketsQuery.limit(5),
  ]);

  return Response.json({
    profile,
    stats: {
      websitesCount: websitesRes.data?.length || 0,
      domainsCount: domainsRes.data?.length || 0,
      databasesCount: dbsRes.data?.length || 0,
      openTicketsCount: (ticketsRes.data || []).filter((t) => t.status === "open").length,
    },
    recentWebsites: websitesRes.data || [],
  });
}

export default function DashboardOverview() {
  const { profile, stats, recentWebsites } = useLoaderData<typeof loader>();

  const statCards = [
    {
      title: "Active Websites",
      value: stats.websitesCount,
      desc: "Hosted on isolated nodes",
      href: "/dashboard/websites",
      color: "from-blue-600 to-cyan-600",
      icon: (
        <svg
          width="20"
          height="20"
          style={{ width: "20px", height: "20px" }}
          className="w-5 h-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
      ),
    },
    {
      title: "Connected Domains",
      value: stats.domainsCount,
      desc: "Auto-SSL provisioned",
      href: "/dashboard/domains",
      color: "from-indigo-600 to-purple-600",
      icon: (
        <svg
          width="20"
          height="20"
          style={{ width: "20px", height: "20px" }}
          className="w-5 h-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      ),
    },
    {
      title: "MySQL Databases",
      value: stats.databasesCount,
      desc: "Managed instances",
      href: "/dashboard/databases",
      color: "from-emerald-600 to-teal-600",
      icon: (
        <svg
          width="20"
          height="20"
          style={{ width: "20px", height: "20px" }}
          className="w-5 h-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
        </svg>
      ),
    },
    {
      title: "Support Tickets",
      value: stats.openTicketsCount,
      desc: "24/7 technical helpdesk",
      href: "/dashboard/support",
      color: "from-amber-500 to-orange-600",
      icon: (
        <svg
          width="20"
          height="20"
          style={{ width: "20px", height: "20px" }}
          className="w-5 h-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      {/* Welcome Banner */}
      <div className="p-6 sm:p-8 bg-gradient-to-r from-slate-900 via-cyan-950 to-slate-900 text-white rounded-3xl shadow-lg border border-slate-800">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 text-xs font-semibold rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
              Infrastructure Status: Healthy
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Welcome back, {profile.full_name}
            </h1>
            <p className="text-sm text-slate-300 max-w-xl">
              DDL Group cloud hosting control plane. Deploy, configure, and monitor your web applications across high-performance isolated runtime nodes.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              to="/dashboard/websites"
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-900 bg-cyan-400 hover:bg-cyan-300 rounded-xl transition shadow-sm"
            >
              + Deploy Website
            </Link>
            <Link
              to="/dashboard/files"
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition"
            >
              File Manager
            </Link>
          </div>
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {statCards.map((c) => (
          <Link
            key={c.title}
            to={c.href}
            className="p-5 bg-white border border-slate-200/90 rounded-2xl shadow-xs hover:shadow-md transition group"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-500">{c.title}</span>
              <div className={`p-2.5 rounded-xl bg-gradient-to-tr ${c.color} shadow-sm`}>
                {c.icon}
              </div>
            </div>
            <div className="mt-4">
              <div className="text-3xl font-black text-slate-900 tracking-tight">
                {c.value}
              </div>
              <p className="mt-1 text-xs text-slate-400 font-medium">{c.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      {/* Resource Allocation & Runtime Environments */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 p-6 bg-white border border-slate-200/90 rounded-2xl shadow-xs">
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Recent Websites</h2>
              <p className="text-xs text-slate-400">Deployed applications and active runtimes</p>
            </div>
            <Link
              to="/dashboard/websites"
              className="text-xs font-semibold text-cyan-600 hover:text-cyan-700 hover:underline"
            >
              View all &rarr;
            </Link>
          </div>

          {recentWebsites.length === 0 ? (
            <div className="text-center py-12 px-4">
              <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-slate-100 text-slate-400">
                <svg
                  width="24"
                  height="24"
                  style={{ width: "24px", height: "24px" }}
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-slate-700">No websites deployed yet</p>
              <p className="mt-1 text-xs text-slate-400">Upload a ZIP archive or connect your repository to deploy.</p>
              <Link
                to="/dashboard/websites"
                className="mt-4 inline-block px-4 py-2 text-xs font-semibold text-white bg-cyan-600 rounded-lg hover:bg-cyan-700"
              >
                Create First Website
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentWebsites.map((site: any) => (
                <div key={site.id} className="py-3 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-800 text-sm">{site.name}</h3>
                    <p className="text-xs text-slate-400 font-mono">{site.subdomain}.ddlgroup.host</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-0.5 text-[11px] font-bold rounded-md bg-slate-100 text-slate-700 uppercase">
                      {site.runtime}
                    </span>
                    <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-emerald-100 text-emerald-800">
                      {site.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Node Health / Runtimes Card */}
        <div className="p-6 bg-white border border-slate-200/90 rounded-2xl shadow-xs space-y-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Runtime Support</h2>
            <p className="text-xs text-slate-400">Available isolated execution environments</p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div className="flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-100 text-orange-700 font-bold text-xs">
                  HTML
                </span>
                <div>
                  <h3 className="text-xs font-semibold text-slate-800">Static Sites</h3>
                  <p className="text-[11px] text-slate-400">HTML5, CSS3, JavaScript, SPA</p>
                </div>
              </div>
              <span className="text-[10px] font-bold text-emerald-600">READY</span>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div className="flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 font-bold text-xs">
                  PHP
                </span>
                <div>
                  <h3 className="text-xs font-semibold text-slate-800">PHP 8.2 & 8.3</h3>
                  <p className="text-[11px] text-slate-400">FastCGI, OPCache, Composer</p>
                </div>
              </div>
              <span className="text-[10px] font-bold text-emerald-600">READY</span>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div className="flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100 text-blue-700 font-bold text-xs">
                  PY
                </span>
                <div>
                  <h3 className="text-xs font-semibold text-slate-800">Python 3.11 & 3.12</h3>
                  <p className="text-[11px] text-slate-400">WSGI/ASGI (Flask, Django, FastAPI)</p>
                </div>
              </div>
              <span className="text-[10px] font-bold text-emerald-600">READY</span>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div className="flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 font-bold text-xs">
                  SQL
                </span>
                <div>
                  <h3 className="text-xs font-semibold text-slate-800">MySQL 8.0</h3>
                  <p className="text-[11px] text-slate-400">Isolated database instances</p>
                </div>
              </div>
              <span className="text-[10px] font-bold text-emerald-600">READY</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
