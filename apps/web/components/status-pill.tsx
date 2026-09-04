import type { ReactNode } from "react";

import { statusTone } from "../lib/labels";
import { TOM, tomDeStatus } from "./tone";

/**
 * Estado como etiqueta — o `.status` do Figma.
 *
 * **A forma mudou, e é a diferença que mais aparece numa tabela cheia de
 * estados:** era uma cápsula (raio 999px) em 12px na fonte de texto; o Figma
 * desenha um CHIP retangular de cantos suaves (raio 4px), em **DM Mono 10px,
 * peso 600, caixa-alta**, com `letter-spacing` de 0,05em. Toda a forma, o peso
 * e a família vêm da classe `.sb-status` em `globals.css`; aqui fica só o tom —
 * e o tom vem de `tone.ts`, o dono único dos cinco pares do Figma. Este
 * componente carregava um mapa próprio (`TONES`) com os mesmos valores sob
 * outros nomes; a auditoria contou cinco cópias e esta era uma delas.
 *
 * Cor NUNCA é a única pista — o texto sempre acompanha, porque cerca de 8% dos
 * homens não distinguem vermelho de verde.
 */
export function StatusPill({ code, label }: { code: string; label: string }): ReactNode {
  return (
    <span className="sb-status" style={TOM[tomDeStatus(statusTone(code))]}>
      {label}
    </span>
  );
}
