"use client";

import { useEffect } from "react";

type MetricName = "TTFB" | "LCP" | "CLS" | "INP";

function report(name: MetricName, value: number): void {
  const payload = JSON.stringify({ name, value: Math.round(value * 100) / 100, path: window.location.pathname });
  try {
    if (navigator.sendBeacon("/api/vitals", new Blob([payload], { type: "application/json" }))) return;
  } catch {
    // Fallback below handles browsers that reject Beacon requests.
  }
  void fetch("/api/vitals", { method: "POST", body: payload, headers: { "content-type": "application/json" }, keepalive: true });
}

/** Métricas de experiência sem conteúdo pessoal: uma amostra por rota e carga. */
export function WebVitals(): null {
  useEffect(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation !== undefined) report("TTFB", navigation.responseStart);

    let lcp = 0;
    let cls = 0;
    let inp = 0;
    const observers: PerformanceObserver[] = [];
    const observe = (type: string, callback: (entry: PerformanceEntry) => void): void => {
      try {
        const observer = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => { callback(entry); });
        });
        observer.observe({ type, buffered: true });
        observers.push(observer);
      } catch {
        // Navegadores sem suporte à métrica são simplesmente excluídos da amostra.
      }
    };
    observe("largest-contentful-paint", (entry) => { lcp = entry.startTime; });
    observe("layout-shift", (entry) => { const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }; if (!shift.hadRecentInput) { cls += shift.value ?? 0; } });
    observe("event", (entry) => { inp = Math.max(inp, (entry as PerformanceEntry & { duration: number }).duration); });

    const flush = (): void => {
      if (lcp > 0) report("LCP", lcp);
      report("CLS", cls);
      if (inp > 0) report("INP", inp);
      observers.forEach((observer) => { observer.disconnect(); });
    };
    document.addEventListener("visibilitychange", flush, { once: true });
    return () => { document.removeEventListener("visibilitychange", flush); observers.forEach((observer) => { observer.disconnect(); }); };
  }, []);
  return null;
}
