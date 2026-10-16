import Link from "next/link";
import type { ReactNode } from "react";

import { EstadoDaTela, TENTAR_DE_NOVO, type AcaoDoEstado } from "../../../../components/estado-da-tela";
import { Panel } from "../../../../components/panel";
import {
  lerItensDevolvidos,
  lerPorSituacao,
  lojaDeTesteDasDevolucoes,
  rotuloDaSolucao,
  separarResumoDevolucoes,
  type LinhaDevolucao,
  type LinhaResumoDevolucoes,
} from "../../../../lib/devolucoes-shopee";
import { formatCount, formatCurrency, formatDateTime } from "../../../../lib/format";
import { isShopeeSchemaMissing } from "../../../../lib/shopee-listings";

interface Resposta<T> {
  readonly data: T[] | null;
  readonly error: { message: string; code?: string } | null;
}

const TITULO = "Devoluções";

/** As mais recentes à vista; o resto, pela loja e pelo período. */
export const DEVOLUCOES_A_VISTA = 10;

/** "1 devolução", "3 devoluções" — o número vem do banco, a palavra concorda com ele. */
function quantos(n: number | null, um: string, varios: string): string {
  return `${formatCount(n)} ${n === 1 ? um : varios}`;
}

/**
 * AS DEVOLUÇÕES DA SHOPEE (D-460; contrato C-62, D-447), decisão do dono de
 * 15/10: um painel em `/vendas/shopee`, logo depois do "Por loja".
 *
 * Duas leituras, as duas do SQL: o resumo (TOTAL, por loja e por situação) e
 * as devoluções mais recentes com os itens e o SKU. A tela não soma nada.
 *
 * O que ela não faz, de propósito:
 * - não traduz a situação: vem como a Shopee manda, porque a documentação não
 *   diz em qual o reembolso foi pago;
 * - não chama o valor de "reembolsado": é o "valor de reembolso informado";
 * - não mostra nada do comprador (o banco não guarda);
 * - não desconta nada da receita: o efeito no recebido já está na composição
 *   do faturamento (C-61, em "outros").
 */
export async function DevolucoesShopee({
  resumo,
  lista,
  periodo,
  tentarDeNovo,
}: {
  resumo: PromiseLike<Resposta<LinhaResumoDevolucoes>>;
  lista: PromiseLike<Resposta<LinhaDevolucao>>;
  periodo: string;
  /** A mesma URL da tela, para "Tentar de novo" (D-470). */
  tentarDeNovo: string;
}): Promise<ReactNode> {
  const acao: AcaoDoEstado = { href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true };
  const [r, l] = await Promise.all([resumo, lista]);

  // A web pode chegar antes da migration de D-447: a novidade ainda não chegou, não é erro.
  if (isShopeeSchemaMissing(r.error)) {
    return (
      <Panel title={TITULO} subtitle={periodo}>
        <EstadoDaTela
          tipo="vazio"
          titulo="A leitura das devoluções da Shopee ainda está sendo ativada neste ambiente"
          descricao="Os números aparecem depois da primeira leitura das lojas."
        />
      </Panel>
    );
  }

  if (r.error !== null) {
    return (
      <Panel title={TITULO} subtitle={periodo}>
        <EstadoDaTela tipo="erro" titulo="Não foi possível carregar as devoluções" detalhe={r.error.message} acao={acao} />
      </Panel>
    );
  }

  const { total, lojas } = separarResumoDevolucoes(r.data);

  return (
    <Panel title={TITULO} subtitle={`${periodo} · criadas no período, como a Shopee informa`}>
      <p role="note" className="sb-an-nota">
        A situação aparece como a Shopee manda: a documentação não diz em qual delas o reembolso foi pago, então o valor é
        o reembolso <b>informado</b>, não o reembolsado. Nada é descontado da receita aqui — o efeito no recebido já está
        no faturamento.
      </p>

      {total === null ? (
        <EstadoDaTela
          tipo="vazio"
          titulo="Nenhuma loja real com as devoluções já lidas"
          descricao="Sem números para o período. A leitura começa sozinha junto com a de pedidos de cada loja."
        />
      ) : (
        <Resumo total={total} lista={l} acao={acao} />
      )}

      {lojas.length > 0 && <Lojas lojas={lojas} />}
    </Panel>
  );
}

function Resumo({
  total,
  lista,
  acao,
}: {
  total: LinhaResumoDevolucoes;
  lista: Resposta<LinhaDevolucao>;
  acao: AcaoDoEstado;
}): ReactNode {
  const situacoes = lerPorSituacao(total.por_situacao);

  return (
    <div className="sb-campanhas-ml-corpo">
      <div className="sb-campanhas-ml-coluna">
        <ul className="sb-valores" aria-label="Devoluções no período">
          <li>
            <span className="sb-valores-rotulo">Devoluções</span>
            <strong className="sb-valores-valor">{formatCount(total.devolucoes)}</strong>
            <span className="sb-valores-nota">
              de {quantos(total.pedidos_com_devolucao, "pedido", "pedidos")} ·{" "}
              {quantos(total.unidades, "unidade", "unidades")} · {formatCount(total.so_reembolso)} só de reembolso
            </span>
          </li>
          <li title="refund_amount, como a Shopee informa">
            <span className="sb-valores-rotulo">Valor de reembolso informado</span>
            <strong className="sb-valores-valor">{formatCurrency(total.valor_reembolso)}</strong>
            <span className="sb-valores-nota">
              {total.valor_reembolso === null
                ? "nenhuma devolução veio com o valor informado"
                : "o que a Shopee informa, não o que foi pago"}
            </span>
          </li>
        </ul>

        <h3 className="sb-campanhas-ml-titulo">Por situação</h3>
        {situacoes === null ? (
          <EstadoDaTela
            tipo="erro"
            titulo="A divisão por situação voltou fora do contrato esperado"
            descricao="Nada é mostrado para não exibir número errado."
            acao={acao}
          />
        ) : situacoes.length === 0 ? (
          <EstadoDaTela tipo="vazio" titulo="Nenhuma devolução no período" />
        ) : (
          <ul className="sb-valores" aria-label="Devoluções por situação">
            {situacoes.map((s) => (
              <li key={s.situacao}>
                <span className="sb-valores-rotulo sb-mono">{s.situacao}</span>
                <strong className="sb-valores-valor">{formatCount(s.devolucoes)}</strong>
                <span className="sb-valores-nota">
                  {quantos(s.unidades, "unidade", "unidades")} · reembolso informado {formatCurrency(s.valorReembolso)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sb-campanhas-ml-coluna">
        <h3 className="sb-campanhas-ml-titulo">
          Mais recentes <small>no período</small>
        </h3>
        <Lista lista={lista} acao={acao} />
      </div>
    </div>
  );
}

function Lista({ lista, acao }: { lista: Resposta<LinhaDevolucao>; acao: AcaoDoEstado }): ReactNode {
  if (lista.error !== null) {
    return <EstadoDaTela tipo="erro" titulo="Não foi possível carregar as devoluções" detalhe={lista.error.message} acao={acao} />;
  }

  const linhas = lista.data ?? [];

  if (linhas.length === 0) {
    return <EstadoDaTela tipo="vazio" titulo="Nenhuma devolução no período" />;
  }

  const total = linhas[0]?.total_count ?? linhas.length;

  return (
    <>
      <ul className="sb-valores" aria-label="Devoluções mais recentes">
        {linhas.map((d) => {
          const itens = lerItensDevolvidos(d.itens);
          const deTeste = lojaDeTesteDasDevolucoes(d);
          const solucao = rotuloDaSolucao(d.return_solution);

          return (
            <li key={`${d.shopee_shop_id}-${d.return_sn}`}>
              <span className="sb-valores-rotulo">
                Pedido <span className="sb-mono">{d.order_sn}</span>
                <small className="sb-mono"> · {d.status}</small>
              </span>
              <strong className="sb-valores-valor" title="Valor de reembolso informado pela Shopee">
                {d.refund_amount === null ? "sem valor" : formatCurrency(d.refund_amount)}
              </strong>
              <span className="sb-valores-nota">
                {[
                  `${d.shop_name}${deTeste ? " (teste)" : ""}`,
                  formatDateTime(d.shopee_created_at),
                  solucao,
                  d.reason === null ? null : `motivo ${d.reason}`,
                ]
                  .filter((parte): parte is string => parte !== null)
                  .join(" · ")}
              </span>
              <span className="sb-valores-nota">
                {itens === null
                  ? "os itens voltaram fora do contrato"
                  : itens.length === 0
                    ? "sem itens lidos"
                    : itens.map((item, indice) => (
                        <span key={`${item.skuId ?? "sem-sku"}-${String(indice)}`}>
                          {indice > 0 && " · "}
                          {item.quantidade === null ? "?" : formatCount(item.quantidade)}×{" "}
                          {item.skuId === null || item.sku === null ? (
                            <span title={item.nome ?? undefined}>sem SKU vinculado</span>
                          ) : (
                            <Link className="sb-mono" href={`/skus/${item.skuId}`} title={item.nome ?? undefined}>
                              {item.sku}
                            </Link>
                          )}
                        </span>
                      ))}
              </span>
            </li>
          );
        })}
      </ul>
      {total > linhas.length && (
        <p className="sb-an-nota">
          Mostrando as {formatCount(linhas.length)} mais recentes de {formatCount(total)} devoluções do período.
        </p>
      )}
    </>
  );
}

/** Uma linha por loja: quantas devoluções, e o que não se sabe dela. */
function Lojas({ lojas }: { lojas: readonly LinhaResumoDevolucoes[] }): ReactNode {
  return (
    <div style={{ marginTop: "var(--sb-space-3)" }}>
      <h3 className="sb-campanhas-ml-titulo">Por loja</h3>
      <ul className="sb-valores" aria-label="Devoluções por loja">
        {lojas.map((loja) => {
          const naoLida = loja.devolucoes === null;
          const deTeste = lojaDeTesteDasDevolucoes(loja);
          const notas = [
            naoLida
              ? "devoluções ainda não lidas"
              : `de ${quantos(loja.pedidos_com_devolucao, "pedido", "pedidos")} · reembolso informado ${formatCurrency(loja.valor_reembolso)}`,
            deTeste ? "loja de teste, fora do total" : null,
            loja.ultima_atualizacao === null ? null : `lidas até ${formatDateTime(loja.ultima_atualizacao)}`,
          ].filter((nota): nota is string => nota !== null);

          return (
            <li key={loja.account_id ?? loja.account_name}>
              <span className="sb-valores-rotulo">
                {loja.account_name ?? "Loja Shopee"}
                {deTeste ? " (teste)" : ""}
              </span>
              <strong className="sb-valores-valor">{naoLida ? "—" : formatCount(loja.devolucoes)}</strong>
              <span className="sb-valores-nota">{notas.join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
