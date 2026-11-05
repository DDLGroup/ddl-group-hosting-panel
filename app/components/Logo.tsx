import { Link } from "@remix-run/react";

const Logo = () => {
  return (
    <Link to="/dashboard" className="flex items-center gap-3 group">
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-tr from-cyan-600 to-blue-600 text-white shadow-md shadow-cyan-500/20">
        <svg
          className="w-6 h-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
          />
        </svg>
      </div>
      <div className="flex flex-col">
        <span className="text-base font-bold tracking-tight text-slate-900 group-hover:text-cyan-600 transition-colors">
          DDL GROUP
        </span>
        <span className="text-[10px] font-semibold tracking-wider text-cyan-600 uppercase">
          Hosting Panel
        </span>
      </div>
    </Link>
  );
};

export default Logo;
