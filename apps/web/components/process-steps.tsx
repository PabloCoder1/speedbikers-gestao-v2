import type { ReactNode } from "react";

/**
 * Indicador de etapas do Figma (`.process-steps`) — a fileira de bolinhas
 * numeradas ligadas por um traço, que o frame usa para dizer em que ponto de
 * um processo um documento está.
 *
 * É `<ol>`, não `<div>`: a ordem é o conteúdo. Um leitor de tela anuncia "1 de
 * 4" sem depender do número desenhado, e a etapa em curso leva
 * `aria-current="step"`.
 *
 * **A forma nunca é a única pista.** No frame, a diferença entre etapa feita e
 * etapa por fazer é só a cor da bolinha; aqui a bolinha traz `✓` no que
 * terminou, `!` no que falhou e `✕` no que foi cancelado, e o `title` diz o
 * estado por extenso. Mesmo raciocínio de `StatusPill`: cerca de 8% dos homens
 * não distinguem vermelho de verde.
 *
 * ## O tipo mora aqui porque o segundo consumidor apareceu
 *
 * Nasceu em `lib/nfe-steps.ts` com a nota de que subiria quando houvesse um
 * segundo — a regra de contenção de `docs/ARCHITECTURE.md` §1. O segundo é
 * `/compras/[id]`: `purchase_orders` tem o ciclo
 * `DRAFT → APPROVED → ORDERED → RECEIVED` **com um carimbo por transição**
 * (`approved_at`, `ordered_at`, `received_at`, `cancelled_at`, e as quatro
 * `CHECK` que impedem estado sem data). Mesma forma, vocabulários diferentes:
 * cada tela traz o seu em `lib/*-steps.ts`, e aqui fica só o desenho.
 */

export type EtapaEstado = "concluida" | "atual" | "pendente" | "falhou" | "cancelada";

export interface EtapaProcesso {
  readonly label: string;
  readonly estado: EtapaEstado;
  /** Detalhe medido da etapa — nunca texto de enfeite. */
  readonly nota?: string;
}

const MARCA: Record<EtapaEstado, string> = {
  concluida: "✓",
  atual: "•",
  pendente: "",
  falhou: "!",
  cancelada: "✕",
};

const POR_EXTENSO: Record<EtapaEstado, string> = {
  concluida: "concluída",
  atual: "em curso",
  pendente: "ainda não começou",
  falhou: "falhou",
  cancelada: "cancelada aqui",
};

export function ProcessSteps({
  etapas,
  rotulo,
}: {
  etapas: readonly EtapaProcesso[];
  /** Nome acessível da lista — cada tela diz de que processo se trata. */
  rotulo: string;
}): ReactNode {
  return (
    <ol className="sb-process-steps" aria-label={rotulo}>
      {etapas.map((etapa, indice) => (
        <li
          key={etapa.label}
          className={`sb-process-step sb-process-step-${etapa.estado}`}
          aria-current={etapa.estado === "atual" ? "step" : undefined}
          title={`${etapa.label}: ${POR_EXTENSO[etapa.estado]}`}
        >
          <b aria-hidden="true">{MARCA[etapa.estado] === "" ? String(indice + 1) : MARCA[etapa.estado]}</b>

          <span>
            {etapa.label}
            {etapa.nota !== undefined && <small>{etapa.nota}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}
