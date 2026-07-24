import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { initAnalytics } from "./lib/analytics";
import { initTheme } from "./lib/theme";
import "./index.css";

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
