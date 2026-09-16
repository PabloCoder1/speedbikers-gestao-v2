import type { CSSProperties, ReactNode } from "react";

import { TOM, type Tom } from "../../../components/tone";
import { reguaDaPolitica, type FaixaDaRegua } from "../../../lib/replenishment-rule";

/**
 * A RÉGUA DA POLÍTICA (D-361) — os quatro números da regra desenhados como as
 * faixas de estado que `/reposicao` vai pintar.
 *
 * Os tons são os de `ESTADOS` em `/reposicao/page.tsx` (D-007: perigo, atenção,
 * ok, informação). As duas faixas de atenção se distinguem pela intensidade: a
 * "comprar em breve" é cheia, a "cobertura baixa" é clara — a primeira pede
 * pedido, a segunda só avisa.
 *
 * Sem hooks e sem `use client`: a página desenha a régua de cada regra no
 * servidor, e a gaveta importa o mesmo componente para redesenhar ao vivo
 * enquanto os números são digitados.
 */

const FAIXAS: Record<FaixaDaRegua, { rotulo: string; tom: Tom; clara?: true }> = {
  COMPRA_URGENTE: { rotulo: "Compra urgente", tom: "perigo" },
  COMPRAR_EM_BREVE: { rotulo: "Comprar em breve", tom: "atencao" },
  COBERTURA_BAIXA: { rotulo: "Cobertura baixa", tom: "atencao", clara: true },
  ADEQUADA: { rotulo: "Adequada", tom: "ok" },
  EXCESSO: { rotulo: "Excesso", tom: "info" },
};

function pct(dias: number, escala: number): string {
  return `${((dias / escala) * 100).toFixed(2)}%`;
}

export function ReguaPolitica({
  prazo,
  cobertura,
  seguranca,
  teto,
  compacta = false,
}: {
  prazo: number;
  cobertura: number;
  seguranca: number;
  teto: number | null;
  /** Na lista de marcas: só a barra, sem marcos nem legenda. */
  compacta?: boolean;
}): ReactNode {
  const regua = reguaDaPolitica({ prazo, cobertura, seguranca, teto });

  const descricao = `Compra urgente até ${String(prazo)} dias de cobertura; ponto de pedido em ${String(regua.pontoDePedido)}; janela de ${String(regua.janela)} dias${teto === null ? "; sem teto de excesso" : `; excesso acima de ${String(teto)}`}.`;

  const marcos: { dias: number; rotulo: string }[] = [
    { dias: regua.pontoDePedido, rotulo: "ponto de pedido" },
    { dias: regua.janela, rotulo: "janela" },
    ...(teto === null ? [] : [{ dias: teto, rotulo: "teto" }]),
  ];

  // Dois marcos no mesmo dia (segurança 0 põe o ponto de pedido no prazo, teto
  // igual à janela) viram um só rótulo, em vez de texto por cima de texto.
  const marcosUnicos = marcos.filter((m, i) => marcos.findIndex((o) => o.dias === m.dias) === i);

  return (
    <figure className={compacta ? "sb-cfg-regua sb-cfg-regua-compacta" : "sb-cfg-regua"}>
      <div className="sb-cfg-regua-barra" role="img" aria-label={descricao}>
        {regua.faixas.map((f) => (
          <span
            key={f.faixa}
            className={FAIXAS[f.faixa].clara === true ? "sb-cfg-regua-faixa sb-cfg-regua-faixa-clara" : "sb-cfg-regua-faixa"}
            style={
              {
                left: pct(f.de, regua.escala),
                width: pct(f.ate - f.de, regua.escala),
                "--sb-cfg-tom": TOM[FAIXAS[f.faixa].tom].color,
              } as CSSProperties
            }
            title={`${FAIXAS[f.faixa].rotulo}: ${String(f.de)}–${f.faixa === "ADEQUADA" && teto === null ? "∞" : f.faixa === "EXCESSO" ? "∞" : String(f.ate)} dias de cobertura`}
          />
        ))}
      </div>

      {!compacta && (
        <>
          <div className="sb-cfg-regua-marcos" aria-hidden="true">
            <span className="sb-cfg-regua-marco" style={{ left: "0%" }}>
              <b>0</b>
            </span>
            {marcosUnicos.map((m) => (
              <span key={m.rotulo} className="sb-cfg-regua-marco" style={{ left: pct(m.dias, regua.escala) }}>
                <b>{m.dias}d</b>
                <small>{m.rotulo}</small>
              </span>
            ))}
          </div>

          <figcaption className="sb-cfg-regua-legenda">
            {regua.faixas.map((f) => (
              <span key={f.faixa} style={{ "--sb-cfg-tom": TOM[FAIXAS[f.faixa].tom].color } as CSSProperties}>
                <i className={FAIXAS[f.faixa].clara === true ? "sb-cfg-legenda-clara" : undefined} aria-hidden="true" />
                {FAIXAS[f.faixa].rotulo}
              </span>
            ))}
          </figcaption>
        </>
      )}
    </figure>
  );
}
