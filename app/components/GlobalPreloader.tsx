import { useFetchers, useNavigation } from "@remix-run/react";

export default function GlobalPreloader() {
  const navigation = useNavigation();
  const fetchers = useFetchers();

  const isNavigating = navigation.state === "loading";
  const isSubmitting = navigation.state === "submitting";
  const isFetcherBusy = fetchers.some((f) => f.state !== "idle");
  const isBusy = isNavigating || isSubmitting || isFetcherBusy;

  if (!isBusy) return null;

  let label = "Loading...";

  if (isSubmitting) {
    const intent = navigation.formData?.get("intent");
    if (intent === "upload_files") {
      label = "Uploading files & syncing to cloud storage...";
    } else if (intent === "deploy_zip") {
      label = "Deploying & extracting website ZIP archive...";
    } else if (intent === "delete_items" || intent === "delete_website" || intent === "delete_domain") {
      label = "Deleting items permanently...";
    } else if (intent === "compress_items") {
      label = "Compressing files into ZIP archive...";
    } else if (intent === "extract_zip") {
      label = "Extracting ZIP archive in place...";
    } else if (intent === "create_file" || intent === "create_folder") {
      label = "Creating new item...";
    } else {
      label = "Processing task, please wait...";
    }
  } else if (isNavigating) {
    label = "Loading page...";
  } else if (isFetcherBusy) {
    label = "Syncing data...";
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 select-none"
    >
      {/* Top Slim Glowing Progress Line */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-400 via-indigo-500 to-cyan-300 animate-pulse shadow-sm shadow-cyan-400/50" />

      {/* Floating Center Rounded Preloader Pill */}
      <div className="fixed top-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-5 py-2.5 bg-slate-900/95 text-white rounded-full shadow-2xl backdrop-blur-md border border-slate-700/80 transition-all duration-200">
        {/* Animated Rounded Spinner */}
        <div className="relative flex items-center justify-center">
          <div className="w-4 h-4 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
        </div>

        {/* Dynamic Status Text */}
        <span className="text-xs font-semibold tracking-wide text-slate-100">
          {label}
        </span>
      </div>
    </div>
  );
}
