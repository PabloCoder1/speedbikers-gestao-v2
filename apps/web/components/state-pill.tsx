import type { ReactNode } from "react";

import { TOM, type Tom } from "./tone";

/**
 * Pílula de estado com vocabulário DA TELA (D-232) — a que `/integracoes`,
 * `/configuracoes`, `/contas` e `/sincronizacao` usam quando o estado não é um
 * código do banco (aí é `StatusPill`) e sim um enum próprio da tela.
 *
 * Era uma CÁPSULA de contorno (raio 999px, 12px, borda na cor). O Figma só
 * tem uma forma de estado — o chip `.status` retangular, DM Mono, caixa-alta —
 * e a auditoria de fidelidade contou esta como a segunda forma e o quinto mapa
 * de tom do app. Agora é o mesmo `.sb-status`, pintado pelo `tone.ts`; o que a
 * distingue de `StatusPill` continua sendo só a assinatura: o tom vem por
 * parâmetro, porque quem sabe o que "parcial" significa é a tela.
 */
export interface PillTone {
  tom: Tom;
  label: string;
}

export function StatePill({ tone }: { tone: PillTone }): ReactNode {
  return (
    <span className="sb-status" style={TOM[tone.tom]}>
      {tone.label}
    </span>
  );
}
