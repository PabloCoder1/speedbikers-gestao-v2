import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../../../components/kpi-strip";
import { Panel } from "../../../../components/panel";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../../lib/format";
import {
  coberturaDoQuemPaga,
  frasesDoQuemPaga,
  lerQuemPagaFrete,
  mlNoFreteDoVendedor,
  rotuloDaLogistica,
  type QuemPagaFrete,
} from "../../../../lib/quem-paga-frete";
import type { createClient } from "../../../../lib/supabase/server";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";

type Cliente = Awaited<ReturnType<typeof createClient>>;

export interface LeituraDoQuemPaga {
  readonly de: string;
  readonly ate: string;
  readonly resposta: Promise<Awaited<ReturnType<Cliente["rpc"]>>>;
}

/**
 * A leitura do "quem paga", disparada pela página no mesmo instante do detector
 * (UX_SYSTEM §6, bloco 3). O bloco era desenhado só depois de o detector
 * responder, e por isso a leitura dele esperava a do detector, apesar de o
 * comentário abaixo dizer que um não espera o outro. Os mesmos 30 dias até
 * ontem, a mesma função.
 */
export function lerQuemPagaOFrete(supabase: Cliente): LeituraDoQuemPaga {
  const hoje = toSalesMetricDate(new Date());
  const de = shiftBusinessDate(hoje, -30);
  const ate = shiftBusinessDate(hoje, -1);
  const resposta = Promise.resolve(supabase.rpc("get_quem_paga_frete", { p_date_from: de, p_date_to: ate }));

  // Se o detector falhar, o bloco não é desenhado e ninguém espera esta leitura.
  void resposta.catch(() => undefined);

  return { de, ate, resposta };
}

/**
 * Quem paga o frete (D-412): o frete dos últimos 30 dias até ontem dividido
 * entre vendedor, comprador e o que o Mercado Livre bancou de cada um, por
 * envio. Bloco à parte do detector, com a sua própria leitura: um não espera
 * o outro.
 */
export async function QuemPagaOFrete({
  leitura,
  tentarDeNovo,
}: {
  /** A leitura já disparada pela página, junto com o detector (`lerQuemPagaOFrete`). */
  leitura: LeituraDoQuemPaga;
  tentarDeNovo: string;
}): Promise<ReactNode> {
  const acao = { href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true };
  const { de, ate } = leitura;
  const resposta = await leitura.resposta;
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
            <EstadoDaTela
              tipo="erro"
              titulo="Não foi possível carregar quem paga o frete"
              detalhe={resposta.error.message}
              acao={acao}
            />
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
          <EstadoDaTela
            tipo="erro"
            titulo="A resposta veio num formato que esta tela não reconhece"
            descricao="Nada foi mostrado."
            acao={acao}
          />
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Quem paga o frete" subtitle={subtitulo}>
      <div className="sb-panel-body">
        {q.envios_com_detalhe === 0 ? (
          <EstadoDaTela tipo="vazio" titulo={coberturaDoQuemPaga(q)} />
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
                    <th className="sb-col-fixa">Logística</th>
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
                        <td className="sb-col-fixa">{rotuloDaLogistica(l.logistica)}</td>
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
      formula: "o valor de tabela do frete no Mercado Livre, antes de dividir quem paga o quê, somado por envio",
      value: formatCurrency(q.frete_cheio),
      previous: null,
    },
    {
      label: "Vendedor pagou",
      formula: "o que o Mercado Livre cobrou do vendedor pelo frete, somado por envio: sai da venda",
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
      formula: "o que o comprador pagou de frete, somado por envio",
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
