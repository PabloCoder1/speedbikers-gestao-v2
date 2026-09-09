/**
 * Os tons do `.status` do Figma, num lugar só.
 *
 * O design system do export declara cinco (`success`, `neutral`, `danger`,
 * `warning`, `info`) e os usa em toda parte: selo de entidade no `ObjectHeader`,
 * chip "ver lista" das células de resumo, coluna de estado das tabelas. O mapa
 * nasceu duplicado em `object-header.tsx`; a segunda cópia seria a que sai de
 * sincronia, então ele passa a morar aqui antes de existir uma segunda.
 *
 * **Os pares são de contraste medido, não do Figma cru.** O `success` do export
 * (`#1b9c7c` sobre `#eaf8f2`) reprova em WCAG 1.4.3 — 2,6:1. Cada `color` aqui é
 * a tinta escura do token correspondente, verificada contra o fundo claro do
 * par; é a mesma correção registrada em `docs/DESIGN_IMPLEMENTATION.md`.
 */
export type Tom = "neutro" | "ok" | "atencao" | "perigo" | "info";

/**
 * Ponte a partir do vocabulário de `statusTone` (lib/labels.ts) — ok/warn/bad/
 * null — para os cinco tons do Figma. `StatusPill` e as telas que pintavam
 * texto por status (`/contas`, `/sincronizacao`) leem daqui; antes cada uma
 * carregava o próprio mapa (a auditoria de fidelidade contou cinco).
 */
export function tomDeStatus(tone: "ok" | "warn" | "bad" | null): Tom {
  switch (tone) {
    case "ok":
      return "ok";
    case "warn":
      return "atencao";
    case "bad":
      return "perigo";
    case null:
      return "neutro";
  }
}

/**
 * Tom do estado da REPUBLICAÇÃO. Nove estados, três desfechos: terminou bem,
 * está a caminho, ou falhou — e falha nunca fica neutra.
 *
 * Morava dentro de `/anuncios/[itemId]` e subiu quando a gaveta do anúncio
 * (D39) virou o segundo leitor: a alternativa era a segunda cópia de um mapa
 * de tom, que é exatamente o que a auditoria de D-246 encontrou cinco vezes.
 */
export function tomDeRelist(status: string): Tom {
  if (status === "REMAPPED" || status === "RELISTED") return "ok";
  if (status.endsWith("_FAILED")) return "perigo";
  if (status === "REQUESTED" || status === "CLOSING" || status === "RELISTING") return "atencao";

  return "neutro";
}

export const TOM: Record<Tom, { background: string; color: string }> = {
  neutro: { background: "var(--sb-neutral-soft)", color: "var(--sb-neutral-ink)" },
  ok: { background: "var(--sb-success-soft)", color: "var(--sb-success)" },
  atencao: { background: "var(--sb-accent-soft)", color: "var(--sb-accent-ink)" },
  perigo: { background: "var(--sb-danger-soft)", color: "var(--sb-danger-ink)" },
  info: { background: "var(--sb-secondary-soft)", color: "var(--sb-secondary)" },
};
