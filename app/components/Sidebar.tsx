import { NavLink, useRouteLoaderData } from "@remix-run/react";
import React from "react";
import Logo from "~/components/Logo";
import type { UserProfile, UserRole } from "~/utils/auth.server";
import CloseIcon from "./icons/Close";

type NavItem = {
  label: string;
  href: string;
  roles?: UserRole[];
  badge?: string;
};

const MAIN_NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Websites", href: "/dashboard/websites" },
  { label: "Domains & SSL", href: "/dashboard/domains" },
  { label: "Databases (MySQL)", href: "/dashboard/databases" },
  { label: "File Manager", href: "/dashboard/files" },
  { label: "Backups", href: "/dashboard/backups" },
];

const ADMIN_NAV_ITEMS: NavItem[] = [
  { label: "User Management", href: "/dashboard/users", roles: ["super_admin", "staff_admin"] },
  { label: "Server Nodes", href: "/dashboard/server-nodes", roles: ["super_admin", "technical_staff"] },
  { label: "Audit Logs", href: "/dashboard/audit-logs", roles: ["super_admin"] },
];

const ACCOUNT_NAV_ITEMS: NavItem[] = [
  { label: "Billing & Plans", href: "/dashboard/billing" },
  { label: "Support Tickets", href: "/dashboard/support" },
  { label: "My Profile", href: "/dashboard/user" },
];

type Props = {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export default function Sidebar({ isOpen, setIsOpen }: Props) {
  const dashboardData = useRouteLoaderData<{ profile?: UserProfile }>("routes/dashboard");
  const userRole: UserRole = dashboardData?.profile?.role || "customer";

  const filterByRole = (items: NavItem[]) => {
    return items.filter((item) => {
      if (!item.roles) return true;
      return item.roles.includes(userRole);
    });
  };

  const renderNavSection = (title: string, items: NavItem[]) => {
    const visibleItems = filterByRole(items);
    if (visibleItems.length === 0) return null;

    return (
      <div className="mb-6">
        <h3 className="px-3 mb-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
          {title}
        </h3>
        <ul className="space-y-1">
          {visibleItems.map((item) => (
            <li key={item.label}>
              <NavLink
                to={item.href}
                onClick={() => setIsOpen(false)}
                className={({ isActive }) =>
                  `flex items-center justify-between px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isActive
                      ? "bg-cyan-50 text-cyan-800 font-semibold shadow-xs"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  }`
                }
                end={item.href === "/dashboard"}
              >
                <span>{item.label}</span>
                {item.badge && (
                  <span className="px-1.5 py-0.5 text-[10px] font-bold text-white bg-cyan-600 rounded-md">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <aside
      className={`fixed top-0 left-0 z-40 flex h-full p-3 w-64 transition-transform ${
        isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      }`}
    >
      <div className="flex flex-col w-full h-full p-4 bg-white rounded-2xl shadow-xl border border-slate-200/80">
        <div className="flex items-center justify-between gap-2 pb-4 mb-4 border-b border-slate-100">
          <Logo />
          <button
            className="flex items-center justify-center w-8 h-8 transition rounded-lg md:hidden text-slate-500 hover:bg-slate-100"
            onClick={() => setIsOpen(false)}
            aria-label="Close sidebar"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 hide-scrollbar pr-1">
          {renderNavSection("Hosting Management", MAIN_NAV_ITEMS)}
          {renderNavSection("Administration", ADMIN_NAV_ITEMS)}
          {renderNavSection("Account & Billing", ACCOUNT_NAV_ITEMS)}
        </div>

        <div className="pt-3 mt-auto border-t border-slate-100">
          <div className="flex items-center justify-between px-2 py-1 text-xs text-slate-400">
            <span>DDL Group Hosting</span>
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Operational
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
