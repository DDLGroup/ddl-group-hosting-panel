import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Outlet, useLoaderData } from "@remix-run/react";
import { useState } from "react";

import MenuIcon from "~/components/icons/Menu";
import ProfilePopup from "~/components/ProfilePopup";
import Sidebar from "~/components/Sidebar";
import { requireUserProfile } from "~/utils/auth.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Dashboard | DDL Group Hosting Panel" },
    { name: "description", content: "DDL Group Professional Web Hosting Management Panel" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { user, profile } = await requireUserProfile(request);
  return Response.json({ user, profile });
}

export default function Dashboard() {
  const { profile } = useLoaderData<typeof loader>();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <Sidebar isOpen={isSidebarOpen} setIsOpen={setIsSidebarOpen} />

      {/* Main Area */}
      <div className="flex-1 flex flex-col md:pl-64 min-w-0">
        {/* Top Header */}
        <header className="sticky top-0 z-30 flex items-center justify-between h-16 px-4 bg-white/80 backdrop-blur-md border-b border-slate-200/80">
          <button
            className="flex items-center justify-center w-10 h-10 transition rounded-lg md:hidden text-slate-700 hover:bg-slate-100"
            onClick={() => setIsSidebarOpen(true)}
            aria-label="Open Navigation Menu"
          >
            <MenuIcon />
          </button>

          <div className="flex items-center gap-3 ml-auto">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-sm font-semibold text-slate-800">{profile.full_name}</span>
              <span className="text-[11px] font-medium text-cyan-600 uppercase">
                {profile.role.replace("_", " ")}
              </span>
            </div>
            <ProfilePopup profile={profile} />
          </div>
        </header>

        {/* Dynamic Page Content */}
        <main className="flex-1 p-4 md:p-8 max-w-7xl w-full mx-auto">
          <Outlet context={{ profile }} />
        </main>
      </div>
    </div>
  );
}
