import Link from "next/link";
import type { ReactNode } from "react";

import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { LinkDeFiltro } from "../../../../components/link-de-filtro";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { formatBusinessDate, formatCount, formatCurrency } from "../../../../lib/format";
import { pageNumbers } from "../../../../lib/listings-dashboard";
import { hrefDoPedidoShopee, lojaDeTesteShopee, shopeeSituacao } from "../../../../lib/shopee-sales";
import {
  hrefDaPaginaDosPedidos,
  janelaDosPedidos,
  type DiaDoSkuPorCanal,
  type PedidoShopeeDoSku,
} from "../../../../lib/sku-shopee";
import { valorOuTraco } from "../../../../lib/vendas-multicanal";

/**
 * A ABA VENDAS DO SKU COM A SHOPEE (D-618), do C-71 do A1 (D-607): o dia a
 * dia por canal e os pedidos da Shopee que contêm o SKU. Só aparece para quem
 * tem loja Shopee, como a seção entre marketplaces da D-444, logo abaixo dela.
 *
 * O grão é o do C-59: o `sku_id` gravado no item. O kit conta como o kit; a
 * página de um componente não mostra a venda do kit que o contém (dito no
 * subtítulo). Cada leitura chega no seu `Suspense`, e a falha fica no painel.
 */

/** A resposta de uma RPC como a página a recebe: o `code` separa a função ausente (PGRST202). */
export interface LeituraDoSku<T> {
  readonly data: readonly T[] | null;
  readonly error: { readonly message: string; readonly code?: string } | null;
}

const GRAO =
  "O produto do item vendido: o kit conta como o kit, e a venda de um kit não aparece na página dos componentes dele.";

function ausente(error: { readonly code?: string } | null): boolean {
  return error?.code === "PGRST202";
}

/** Uma célula de canal: a receita e as unidades embaixo; canal sem venda no dia é "—", nunca zero. */
function CelulaDoCanal({
  receita,
  unidades,
  semReceita = 0,
}: {
  receita: number | null;
  unidades: number | null;
  semReceita?: number | null;
}): ReactNode {
  if (unidades === null) return <td className="sb-num">—</td>;

  return (
    <td className="sb-num">
      {valorOuTraco(receita, formatCurrency)}
      <small className="sb-an-sub">{formatCount(unidades)} un</small>
      {(semReceita ?? 0) > 0 && <small className="sb-an-sub">{formatCount(semReceita ?? 0)} itens sem receita conhecida</small>}
    </td>
  );
}

export async function DiaADiaPorCanal({
  leitura,
  dias,
  tentarDeNovo,
}: {
  leitura: Promise<LeituraDoSku<DiaDoSkuPorCanal>>;
  dias: number;
  tentarDeNovo: string;
}): Promise<ReactNode> {
  const resposta = await leitura;

  return (
    <Panel
      title="Por dia, por canal"
      subtitle={`últimos ${String(dias)} dias · o total do dia somado no banco · a loja Shopee de teste fica fora. ${GRAO}`}
    >
      {resposta.error !== null && ausente(resposta.error) ? (
        <EstadoDaTela tipo="vazio" titulo="O dia a dia por canal ainda não está disponível neste ambiente" />
      ) : resposta.error !== null || resposta.data === null ? (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar o dia a dia por canal"
          detalhe={resposta.error?.message ?? "sem resposta"}
          acao={{ href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      ) : resposta.data.length === 0 ? (
        <EstadoDaTela
          tipo="vazio"
          titulo="Nenhum dia com venda deste produto no período"
          descricao="Dias sem venda não aparecem: o banco não fabrica zero."
        />
      ) : (
        <div className="sb-skud-scroll">
          <table className="sb-table sb-skud-min-44" aria-label="Vendas do produto por dia e por canal">
            <thead>
              <tr>
                <th>Dia</th>
                <th className="sb-num">Mercado Livre</th>
                <th className="sb-num">Shopee</th>
                <th className="sb-num">Total do dia</th>
              </tr>
            </thead>
            <tbody>
              {resposta.data.map((linha) => (
                <tr key={linha.dia}>
                  {/* Data de negócio (YYYY-MM-DD): formatar por string, nunca por `new Date`. */}
                  <td className="sb-skud-nowrap">{formatBusinessDate(linha.dia)}</td>
                  <CelulaDoCanal receita={linha.receita_ml} unidades={linha.unidades_ml} />
                  <CelulaDoCanal
                    receita={linha.receita_shopee}
                    unidades={linha.unidades_shopee}
                    semReceita={linha.itens_shopee_sem_receita}
                  />
                  <td className="sb-num">
                    <strong>{valorOuTraco(linha.receita_bruta, formatCurrency)}</strong>
                    <small className="sb-an-sub">{formatCount(linha.unidades)} un</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export async function PedidosShopeeDoSku({
  leitura,
  skuId,
  pagina,
  dias,
  tentarDeNovo,
}: {
  leitura: Promise<LeituraDoSku<PedidoShopeeDoSku>>;
  skuId: string;
  pagina: number;
  dias: number;
  tentarDeNovo: string;
}): Promise<ReactNode> {
  const resposta = await leitura;
  const pedidos = resposta.data ?? [];
  const total = pedidos[0]?.total_count ?? 0;
  const janela = janelaDosPedidos(pagina, total, pedidos.length);

  return (
    <Panel
      title="Pedidos da Shopee com este produto"
      subtitle={`últimos ${String(dias)} dias · todas as situações, mais novos primeiro · unidades e receita só deste produto no pedido`}
    >
      {resposta.error !== null && ausente(resposta.error) ? (
        <EstadoDaTela tipo="vazio" titulo="Os pedidos da Shopee por produto ainda não estão disponíveis neste ambiente" />
      ) : resposta.error !== null || resposta.data === null ? (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar os pedidos da Shopee"
          detalhe={resposta.error?.message ?? "sem resposta"}
          acao={{ href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      ) : pedidos.length === 0 ? (
        pagina > 1 ? (
          <EstadoDaTela
            tipo="vazio"
            titulo="Esta página não tem pedidos"
            acao={{ href: hrefDaPaginaDosPedidos(skuId, 1), rotulo: "Voltar à primeira página", mesmaTela: true }}
          />
        ) : (
          <EstadoDaTela tipo="vazio" titulo="Nenhum pedido da Shopee com este produto no período" />
        )
      ) : (
        <>
          <div className="sb-skud-scroll">
            <table className="sb-table sb-skud-min-44" aria-label="Pedidos da Shopee com este produto">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Loja</th>
                  <th>Dia</th>
                  <th>Situação</th>
                  <th className="sb-num">Unidades</th>
                  <th className="sb-num">Receita</th>
                </tr>
              </thead>
              <tbody>
                {pedidos.map((pedido) => {
                  const situacao = shopeeSituacao(pedido.situacao);
                  const href = hrefDoPedidoShopee(pedido.shopee_shop_id, pedido.dia, pedido.order_sn);

                  return (
                    <tr key={`${pedido.shopee_shop_id}:${pedido.order_sn}`}>
                      <td>
                        <span className="sb-mono">{pedido.order_sn}</span>
                        {href !== null && (
                          <small className="sb-an-sub">
                            <Link href={href}>Abrir pedido</Link>
                          </small>
                        )}
                      </td>
                      <td>
                        {pedido.shop_name ?? "Loja Shopee"}
                        {lojaDeTesteShopee(pedido.environment) && (
                          <span className="sb-an-meta">
                            <StatePill tone={{ tom: "atencao", label: "Teste" }} /> fora das somas
                          </span>
                        )}
                      </td>
                      <td className="sb-skud-nowrap">{formatBusinessDate(pedido.dia)}</td>
                      <td>
                        {situacao === null ? (
                          pedido.situacao
                        ) : (
                          <span title={situacao.criterio}>
                            <StatePill tone={{ tom: situacao.tom, label: situacao.rotulo }} />
                          </span>
                        )}
                      </td>
                      <td className="sb-num">{valorOuTraco(pedido.unidades_do_sku, formatCount)}</td>
                      {/* Receita DESCONHECIDA é "—", nunca zero: um item de preço 0 não diz quanto vale. */}
                      <td className="sb-num">
                        {pedido.receita_do_sku === null ? (
                          <>
                            —<small className="sb-an-sub">sem receita conhecida</small>
                          </>
                        ) : (
                          formatCurrency(pedido.receita_do_sku)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <nav className="sb-an-paginacao" aria-label="Paginação dos pedidos da Shopee com este produto">
            <span className="sb-an-suave">{janela.label}</span>
            {janela.totalPages > 1 && (
              <div className="sb-an-paginas">
                {pagina > 1 ? (
                  <LinkDeFiltro className="sb-button" href={hrefDaPaginaDosPedidos(skuId, pagina - 1)}>
                    ‹ Anterior
                  </LinkDeFiltro>
                ) : (
                  <span className="sb-button" aria-disabled="true">
                    ‹ Anterior
                  </span>
                )}
                {pageNumbers(pagina, janela.totalPages).map((numero, indice) =>
                  numero === "…" ? (
                    <span key={`salto-${String(indice)}`} className="sb-an-salto" aria-hidden="true">
                      …
                    </span>
                  ) : numero === pagina ? (
                    <span key={numero} className="sb-button sb-button-primary" aria-current="page">
                      {numero}
                    </span>
                  ) : (
                    <LinkDeFiltro key={numero} className="sb-button" href={hrefDaPaginaDosPedidos(skuId, numero)}>
                      {numero}
                    </LinkDeFiltro>
                  ),
                )}
                {pagina < janela.totalPages ? (
                  <LinkDeFiltro className="sb-button" href={hrefDaPaginaDosPedidos(skuId, pagina + 1)}>
                    Próxima ›
                  </LinkDeFiltro>
                ) : (
                  <span className="sb-button" aria-disabled="true">
                    Próxima ›
                  </span>
                )}
              </div>
            )}
          </nav>
        </>
      )}
    </Panel>
  );
}
