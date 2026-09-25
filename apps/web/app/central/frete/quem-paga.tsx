import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { Panel } from "../../../components/panel";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../lib/format";
import {
  coberturaDoQuemPaga,
  frasesDoQuemPaga,
  lerQuemPagaFrete,
  mlNoFreteDoVendedor,
  rotuloDaLogistica,
  type QuemPagaFrete,
} from "../../../lib/quem-paga-frete";
import { createClient } from "../../../lib/supabase/server";
import { AVISO } from "../../faturamento/numeros";

/**
 * Quem paga o frete (D-412): o frete dos últimos 30 dias até ontem dividido
 * entre vendedor, comprador e o que o Mercado Livre bancou de cada um, por
 * envio. Bloco à parte do detector, com a sua própria leitura: um não espera
 * o outro.
 */
export async function QuemPagaOFrete(): Promise<ReactNode> {
  const hoje = toSalesMetricDate(new Date());
  const de = shiftBusinessDate(hoje, -30);
  const ate = shiftBusinessDate(hoje, -1);
  const supabase = await createClient();
  const resposta = await supabase.rpc("get_quem_paga_frete", { p_date_from: de, p_date_to: ate });
  const subtitulo = `${formatBusinessDate(de)} a ${formatBusinessDate(ate)} · todas as contas · somado por envio`;

  // Função ausente (PGRST202): a web chega à produção antes da migration.
  if (resposta.error !== null) {
    return (
      <Panel title="Quem paga o frete" subtitle={subtitulo}>
        <div className="sb-panel-body">
          {resposta.error.code === "PGRST202" ? (
            <div className="sb-note">
              <span>SENDO ATIVADO</span>
              <p>Este bloco está sendo ativado: o banco ainda não recebeu a função de D-412.</p>
            </div>
          ) : (
            <p role="alert" style={AVISO}>
              Não foi possível carregar quem paga o frete: {resposta.error.message}
            </p>
          )}
        </div>
      </Panel>
    );
  }

  const q = lerQuemPagaFrete(resposta.data);

  if (q === null) {
    return (
      <Panel title="Quem paga o frete" subtitle={subtitulo}>
        <div className="sb-panel-body">
          <p role="alert" style={AVISO}>
            A resposta veio num formato que esta tela não reconhece — nada foi mostrado.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Quem paga o frete" subtitle={subtitulo}>
      <div className="sb-panel-body">
        {q.envios_com_detalhe === 0 ? (
          <p className="sb-empty">{coberturaDoQuemPaga(q)}</p>
        ) : (
          <>
            <KpiStrip cells={celulas(q)} />

            <div className="sb-central-frases sb-central-bloco">
              {frasesDoQuemPaga(q).map((frase) => (
                <p key={frase}>{frase}</p>
              ))}
            </div>

            <div className="sb-central-tabela sb-central-bloco">
              <table className="sb-table">
                <caption className="sb-sr-only">Quem paga o frete por logística</caption>
                <thead>
                  <tr>
                    <th>Logística</th>
                    <th className="sb-num">Envios</th>
                    <th className="sb-num">Vendedor pagou</th>
                    <th className="sb-num">ML bancou do vendedor</th>
                    <th className="sb-num">Comprador pagou</th>
                    <th className="sb-num">ML bancou do comprador</th>
                    <th className="sb-num">Frete grátis</th>
                  </tr>
                </thead>
                <tbody>
                  {q.por_logistica.map((l) => {
                    const ml = mlNoFreteDoVendedor(l);

                    return (
                      <tr key={l.logistica}>
                        <td>{rotuloDaLogistica(l.logistica)}</td>
                        <td className="sb-num">{formatCount(l.envios)}</td>
                        <td className="sb-num">{formatCurrency(l.vendedor_pagou)}</td>
                        <td className="sb-num">
                          {formatCurrency(l.ml_bancou_vendedor)}
                          {ml === null ? "" : ` (${formatPercent(ml)})`}
                        </td>
                        <td className="sb-num">{formatCurrency(l.comprador_pagou)}</td>
                        <td className="sb-num">{formatCurrency(l.ml_bancou_comprador)}</td>
                        <td className="sb-num">{formatCount(l.frete_gratis_comprador)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="sb-note sb-central-bloco">
              <span>COBERTURA</span>
              <p>{coberturaDoQuemPaga(q)}</p>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function celulas(q: QuemPagaFrete): KpiCellData[] {
  const ml = mlNoFreteDoVendedor(q);

  return [
    {
      label: "Frete cheio",
      formula: "gross_amount somado por envio: a tabela do Mercado Livre antes de quem paga o quê",
      value: formatCurrency(q.frete_cheio),
      previous: null,
    },
    {
      label: "Vendedor pagou",
      formula: "senders[].cost somado por envio -- o que sai da venda",
      value: formatCurrency(q.vendedor_pagou),
      previous: null,
      ressalva: `de ${formatCurrency(q.frete_do_vendedor)} que cabiam ao vendedor`,
    },
    {
      metricId: "frete_bancado_ml_vendedor",
      label: "ML bancou do vendedor",
      formula: "desconto do Mercado Livre no frete do vendedor, somado por envio",
      value: formatCurrency(q.ml_bancou_vendedor),
      previous: null,
      ...(ml === null ? {} : { ressalva: `${formatPercent(ml)} do frete que cabia ao vendedor` }),
    },
    {
      metricId: "frete_pago_comprador",
      label: "Comprador pagou",
      formula: "receiver.cost somado por envio",
      value: formatCurrency(q.comprador_pagou),
      previous: null,
    },
    {
      metricId: "frete_bancado_ml_comprador",
      label: "ML bancou do comprador",
      formula: "descontos do comprador somados por envio; frete grátis = comprador pagou zero",
      value: formatCurrency(q.ml_bancou_comprador),
      previous: null,
      ressalva: `${formatCount(q.frete_gratis_comprador)} envios com frete grátis`,
    },
  ];
}
