"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { descreverElemento, formaDoElemento } from "../lib/vitals-elemento";

type MetricName = "TTFB" | "LCP" | "CLS" | "INP";

const INPUTS = ["keydown", "click"] as const;

function report(name: MetricName, value: number, path: string, softNav: boolean, el?: string): void {
  const payload = JSON.stringify({ name, value: Math.round(value * 100) / 100, path, softNav, ...(el === undefined ? {} : { el }) });
  try {
    if (navigator.sendBeacon("/api/vitals", new Blob([payload], { type: "application/json" }))) return;
  } catch {
    // Fallback below handles browsers that reject Beacon requests.
  }
  void fetch("/api/vitals", { method: "POST", body: payload, headers: { "content-type": "application/json" }, keepalive: true });
}

/**
 * O elemento de uma métrica pela forma (D-516): a tag e as classes `sb-*` dele, e a seção em que mora pela
 * posição entre as seções do conteúdo. Nunca o texto, o `id` ou o `aria-label` (`lib/vitals-elemento.ts`).
 */
function descrever(no: Node | null | undefined): string | undefined {
  if (!(no instanceof Element)) return undefined;
  const forma = (el: Element): string => formaDoElemento(el.tagName, el.classList);
  const secao = no.parentElement?.closest("section") ?? null;
  if (secao === null) return descreverElemento(forma(no), null);
  const posicao = [...document.querySelectorAll(".sb-content section")].indexOf(secao) + 1;
  return descreverElemento(forma(no), { forma: forma(secao), posicao });
}

/**
 * O componente monta uma vez por documento e sobrevive à navegação suave, então a rota de cada
 * métrica é a CARREGADA, guardada na montagem — antes, LCP e CLS saíam com a rota em que a aba se
 * escondeu (D-506, D-507). `softNav` diz se a URL mudou antes do envio: o CLS e o INP somam o
 * documento inteiro, inclusive o que veio depois da tela carregada.
 */
function Coleta(): null {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const softNav = useRef(false);
  const lastUrl = useRef<string | null>(null);

  // Rota ou filtro novo no mesmo documento é navegação suave; voltar à URL da carga não desfaz.
  useEffect(() => {
    const url = `${pathname}?${search}`;
    if (lastUrl.current !== null && lastUrl.current !== url) softNav.current = true;
    lastUrl.current = url;
  }, [pathname, search]);

  useEffect(() => {
    const path = window.location.pathname;
    const send = (name: MetricName, value: number, el?: string): void => { report(name, value, path, softNav.current, el); };

    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation !== undefined) send("TTFB", navigation.responseStart);

    // Aba aberta em segundo plano só pinta quando alguém olha: o LCP dela mediria a pessoa, não a carga.
    let hiddenAt = document.visibilityState === "hidden" ? 0 : Number.POSITIVE_INFINITY;
    let lcp = 0;
    let lcpEl: string | undefined;
    let cls = 0;
    // O maior deslocamento sozinho diz quem mais pesou no CLS (D-516).
    let maiorShift = 0;
    let clsEl: string | undefined;
    let inp = 0;
    const observe = (type: string, callback: (entry: PerformanceEntry) => void): (() => void) => {
      try {
        const observer = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => { callback(entry); });
        });
        observer.observe({ type, buffered: true });
        // Esvazia o que o navegador ainda não entregou antes de parar de ouvir.
        return () => { observer.takeRecords().forEach((entry) => { callback(entry); }); observer.disconnect(); };
      } catch {
        // Navegadores sem suporte à métrica são simplesmente excluídos da amostra.
        return () => undefined;
      }
    };
    const stopLcp = observe("largest-contentful-paint", (entry) => {
      if (entry.startTime >= hiddenAt) return;
      lcp = entry.startTime;
      lcpEl = descrever((entry as PerformanceEntry & { element?: Element | null }).element);
    });
    const stopCls = observe("layout-shift", (entry) => {
      const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number; sources?: { node?: Node | null }[] };
      if (shift.hadRecentInput) return;
      const valor = shift.value ?? 0;
      cls += valor;
      if (valor > maiorShift) { maiorShift = valor; clsEl = descrever(shift.sources?.[0]?.node); }
    });
    const stopInp = observe("event", (entry) => { inp = Math.max(inp, (entry as PerformanceEntry & { duration: number }).duration); });

    // O navegador para de emitir LCP no primeiro clique ou tecla; como na biblioteca web-vitals, ele
    // sai ali, com a aba viva, em vez de esperar ela se esconder.
    let lcpSent = false;
    const sendLcp = (): void => {
      if (lcpSent) return;
      lcpSent = true;
      stopLcp();
      if (lcp > 0) send("LCP", lcp, lcpEl);
    };
    let inputTimer: number | undefined;
    const onInput = (): void => {
      INPUTS.forEach((type) => { window.removeEventListener(type, onInput, true); });
      // Fora do tratador, para não pesar na própria interação.
      inputTimer = window.setTimeout(sendLcp, 0);
    };

    let flushed = false;
    const flush = (): void => {
      if (flushed) return;
      flushed = true;
      hiddenAt = Math.min(hiddenAt, performance.now());
      sendLcp();
      stopCls();
      stopInp();
      send("CLS", cls, clsEl);
      if (inp > 0) send("INP", inp);
      removeListeners();
    };
    const onVisibilityChange = (): void => { if (document.visibilityState === "hidden") flush(); };
    const removeListeners = (): void => {
      INPUTS.forEach((type) => { window.removeEventListener(type, onInput, true); });
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
    };

    INPUTS.forEach((type) => { window.addEventListener(type, onInput, true); });
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Safari antigo sai da página sem avisar a troca de visibilidade.
    window.addEventListener("pagehide", flush);
    return () => { removeListeners(); window.clearTimeout(inputTimer); stopLcp(); stopCls(); stopInp(); };
  }, []);
  return null;
}

/** Métricas de experiência sem conteúdo pessoal: uma amostra por carga, com nome, valor, rota, `softNav` e, no LCP e no CLS, o elemento pela forma (D-516). */
export function WebVitals(): ReactNode {
  // `useSearchParams` só existe na requisição: sem o limite, o build não pré-renderiza.
  return <Suspense fallback={null}><Coleta /></Suspense>;
}
