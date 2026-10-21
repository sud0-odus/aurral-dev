import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { initializeTheme } from "./utils/theme.js";

initializeTheme();

if (!window.location.pathname.endsWith("/oauth.html")) {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Browser-side response/performance instrumentation is opt-in. No media URLs,
// track titles, account identity or browsing history are recorded.
if (new URLSearchParams(window.location.search).get("aurralPerf") === "1") {
  if (typeof PerformanceObserver !== "undefined"
    && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType !== "longtask") continue;
        console.info("[Aurral perf] UI long task", { durationMs: Math.round(entry.duration) });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  }
  window.addEventListener("load", () => {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (!navigation) return;
    console.info("[Aurral perf] navigation", {
      domInteractiveMs: Math.round(navigation.domInteractive),
      loadMs: Math.round(navigation.loadEventEnd),
    });
  }, { once: true });
}
