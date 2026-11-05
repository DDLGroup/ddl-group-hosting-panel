import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";

export const meta: MetaFunction = () => {
  return [
    { title: "Registration Disabled | DDL Group Hosting Panel" },
  ];
};

export default function SignUp() {
  return (
    <div className="w-full max-w-md p-8 bg-white border border-slate-200 shadow-xl rounded-2xl text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 mb-4 rounded-xl bg-amber-100 text-amber-700">
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>

      <h1 className="text-xl font-bold text-slate-900 mb-2">
        Public Registration Is Disabled
      </h1>

      <p className="text-sm text-slate-600 mb-6">
        DDL Group Hosting accounts are provisioned exclusively by authorized system administrators. If you are an active client or staff member, please contact your account manager for login credentials.
      </p>

      <Link
        to="/login"
        className="inline-flex items-center justify-center w-full px-4 py-2.5 text-sm font-semibold text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition"
      >
        Return to Sign In
      </Link>
    </div>
  );
}
