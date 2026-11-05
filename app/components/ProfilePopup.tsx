import { Form, Link, useRouteLoaderData } from "@remix-run/react";
import { useRef, useState } from "react";
import type { UserProfile } from "~/utils/auth.server";
import Popup from "./Popup";

type Props = {
  profile?: UserProfile;
};

export default function ProfilePopup({ profile: propProfile }: Props) {
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const popupButtonRef = useRef<HTMLButtonElement>(null);
  const dashboardData = useRouteLoaderData<{ profile?: UserProfile }>("routes/dashboard");

  const profile = propProfile || dashboardData?.profile || {
    full_name: "Hosting User",
    email: "user@ddlgroup.com",
    role: "customer" as const,
    status: "active" as const,
  };

  const roleBadgeColors: Record<string, string> = {
    super_admin: "bg-purple-100 text-purple-700 border-purple-200",
    staff_admin: "bg-blue-100 text-blue-700 border-blue-200",
    technical_staff: "bg-cyan-100 text-cyan-700 border-cyan-200",
    support_staff: "bg-amber-100 text-amber-700 border-amber-200",
    customer: "bg-emerald-100 text-emerald-700 border-emerald-200",
  };

  const initials = profile.full_name
    ? profile.full_name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase()
    : "US";

  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 p-1 transition rounded-full hover:ring-2 hover:ring-cyan-400 focus:outline-none"
        onClick={() => setIsPopupOpen(!isPopupOpen)}
        ref={popupButtonRef}
        aria-label="User profile menu"
      >
        <div className="flex items-center justify-center w-10 h-10 font-bold text-white rounded-full bg-gradient-to-tr from-cyan-600 to-slate-800 shadow-sm text-sm">
          {initials}
        </div>
      </button>

      {isPopupOpen && (
        <Popup
          isOpen={isPopupOpen}
          setIsOpen={setIsPopupOpen}
          buttonRef={popupButtonRef}
          className="right-0 w-64 p-3 mt-2 bg-white rounded-xl shadow-xl border border-slate-100 top-full z-50"
        >
          <div className="px-3 py-2 border-b border-slate-100">
            <p className="font-semibold text-slate-900 truncate">{profile.full_name}</p>
            <p className="text-xs text-slate-500 truncate">{profile.email}</p>
            <div className="mt-2">
              <span
                className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase rounded-md border ${
                  roleBadgeColors[profile.role] || "bg-slate-100 text-slate-700"
                }`}
              >
                {profile.role.replace("_", " ")}
              </span>
            </div>
          </div>

          <div className="py-2 space-y-1">
            <Link
              to="/dashboard/user"
              onClick={() => setIsPopupOpen(false)}
              className="flex items-center px-3 py-2 text-sm text-slate-700 rounded-lg transition hover:bg-slate-50"
            >
              Account Profile
            </Link>
            <Form action="/logout" method="POST">
              <button
                type="submit"
                className="w-full text-left px-3 py-2 text-sm text-rose-600 font-medium rounded-lg transition hover:bg-rose-50"
              >
                Sign Out
              </button>
            </Form>
          </div>
        </Popup>
      )}
    </div>
  );
}
