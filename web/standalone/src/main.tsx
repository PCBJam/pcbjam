import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { initAnalytics } from "./lib/analytics";
import { initErrorReporting } from "./lib/error-reporting";
import { initTheme } from "./lib/theme";
import { installFatalScreenListeners } from "./wasm/fatal-screen";
import "./index.css";

// Error tracking (Better Stack), only when VITE_ERRORS_DSN is set. FIRST and
// synchronous, so its window handlers are live before anything else runs —
// including the fatal-screen floor below and WasmTool's 175–338 MB boot, where
// the crashes worth catching happen.
initErrorReporting();

// The React-independent blue-screen floor: installed before React mounts so a
// wasm trap can never end in a white page, even if React unmounts itself
// (which it did, three prod releases in a row — see async/16).
installFatalScreenListeners();

// Privacy-friendly analytics (Plausible), only when VITE_PLAUSIBLE_SRC is set.
initAnalytics();

// Re-assert the resolved theme (index.html applied it pre-paint; this keeps
// SPA state consistent if that inline script is ever bypassed, e.g. tests
// mounting the app directly).
initTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

// NOTE: deliberately NOT wrapped in <React.StrictMode>. StrictMode double-mounts
// components in dev, which would re-run WasmTool's boot effect and try to
// instantiate a 175–338 MB KiCad wasm twice — enough to OOM the tab (and the
// runtime is process-global anyway; see src/wasm/boot.ts). The tool view must
// instantiate exactly once per navigation.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
