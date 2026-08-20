import type { ReactNode } from "react";

import { statusTone } from "../lib/labels";

const TONES = {
  ok: { background: "#e6f4ea", color: "#136c34" },
  warn: { background: "#fff8dc", color: "var(--sb-accent-ink)" },
  bad: { background: "#fdeaea", color: "var(--sb-danger)" },
  none: { background: "var(--sb-muted)", color: "var(--sb-text)" },
};

/**
 * Estado como etiqueta. Cor NUNCA é a única pista — o texto sempre acompanha,
 * porque cerca de 8% dos homens não distinguem vermelho de verde.
 */
export function StatusPill({ code, label }: { code: string; label: string }): ReactNode {
  const tone = TONES[statusTone(code) ?? "none"];

  return (
    <span
      style={{
        ...tone,
        display: "inline-block",
        borderRadius: "999px",
        padding: "0.125rem 0.5rem",
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
