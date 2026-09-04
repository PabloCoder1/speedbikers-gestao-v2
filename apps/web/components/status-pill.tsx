import type { ReactNode } from "react";

import { statusTone } from "../lib/labels";

/**
 * Estado como etiqueta — o `.status` do Figma.
 *
 * **A forma mudou, e é a diferença que mais aparece numa tabela cheia de
 * estados:** era uma cápsula (raio 999px) em 12px na fonte de texto; o Figma
 * desenha um CHIP retangular de cantos suaves (raio 4px), em **DM Mono 10px,
 * peso 600, caixa-alta**, com `letter-spacing` de 0,05em. Toda a forma, o peso
 * e a família vêm da classe `.sb-status` em `globals.css`; aqui fica só o tom.
 *
 * **Os fundos são os exatos do Figma; as tintas são as medidas.** A tinta de
 * `success` dele (`#178263`) dá 4,36x sobre o próprio fundo e reprova AA — as
 * daqui passam, e passam melhor nos fundos dele do que nos antigos (5,96x
 * contra 5,74x). Medido em D1/D2 e reconferido ao unificar a paleta.
 *
 * Cor NUNCA é a única pista — o texto sempre acompanha, porque cerca de 8% dos
 * homens não distinguem vermelho de verde.
 */
const TONES = {
  ok: { background: "var(--sb-success-soft)", color: "var(--sb-success)" },
  warn: { background: "var(--sb-accent-soft)", color: "var(--sb-accent-ink)" },
  bad: { background: "var(--sb-danger-soft)", color: "var(--sb-danger-ink)" },
  none: { background: "var(--sb-neutral-soft)", color: "var(--sb-neutral-ink)" },
};

export function StatusPill({ code, label }: { code: string; label: string }): ReactNode {
  const tone = TONES[statusTone(code) ?? "none"];

  return (
    <span className="sb-status" style={tone}>
      {label}
    </span>
  );
}
