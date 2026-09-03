import type { ReactNode } from "react";

/**
 * Pílula de estado em CONTORNO (D-232) — a que `/integracoes` e
 * `/configuracoes` usam para vocabulários fechados de estado.
 *
 * Nasceu privada em `/integracoes` e saiu para cá quando a segunda tela a
 * copiou: a revisão de D-231 contou "segunda pílula, quinto mapa de tons" e o
 * caminho para um sexto era não ter componente. Difere de `StatusPill` (que
 * pinta o FUNDO a partir de `statusTone`) de propósito: aqui o vocabulário é
 * da tela, não um código do banco, e o mapa de tom vem por parâmetro.
 */
export interface PillTone {
  color: string;
  label: string;
}

/**
 * Cor semântica de um tom de `statusTone` (labels.ts) — a MESMA em `/contas`,
 * `/sincronizacao` e `/integracoes`, que antes carregavam três mapas próprios
 * de cor por status de conta.
 */
export function toneColor(tone: "ok" | "warn" | "bad" | null): string {
  switch (tone) {
    case "ok":
      return "var(--sb-secondary)";
    case "warn":
      return "var(--sb-accent-ink)";
    case "bad":
      return "var(--sb-danger)";
    case null:
      return "var(--sb-muted-ink)";
  }
}

export function StatePill({ tone }: { tone: PillTone }): ReactNode {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.0625rem 0.5rem",
        borderRadius: "999px",
        border: `1px solid ${tone.color}`,
        color: tone.color,
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {tone.label}
    </span>
  );
}
