import type { ReactNode } from "react";

import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { KpiStrip, type KpiCellData } from "../../../../components/kpi-strip";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import { formatCount, formatCurrency } from "../../../../lib/format";
import { MARKETPLACE_ROTULO } from "../../../../lib/marketplace";
import { contaDeTeste, separarVendasDoSku, type VendaDoSkuPorConta } from "../../../../lib/vendas-por-sku";

/**
 * As vendas do SKU ENTRE OS MARKETPLACES (D-444, etapa T6a), do C-59
 * (`get_sku_sales_by_marketplace_account`, D-439): o total da operação — já
 * somado no SQL, sem a loja de teste — e uma linha por conta do Mercado Livre
 * e por loja Shopee.
 *
 * Mora ACIMA do detalhe do Mercado Livre da aba Vendas, que continua o de
 * sempre (pedidos, ticket e o dia a dia são do ML). Só aparece para quem tem
 * loja Shopee: sem ela, a linha por conta repetiria a tabela do ML.
 */
export function VendasEntreMarketplaces({
  linhas,
  erro,
  dias,
  tentarDeNovo,
}: {
  linhas: readonly VendaDoSkuPorConta[];
  erro: { message: string } | null;
  dias: number;
  /** A mesma URL, para "Tentar de novo" (D-474). */
  tentarDeNovo?: string;
}): ReactNode {
  if (erro !== null) {
    return (
      <EstadoDaTela
        tipo="erro"
        titulo="Não foi possível carregar as vendas entre marketplaces"
        detalhe={erro.message}
        acao={tentarDeNovo === undefined ? undefined : { href: tentarDeNovo, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
      />
    );
  }

  const { total, contas } = separarVendasDoSku(linhas);
  const semReceita = total?.itens_sem_receita ?? 0;

  const celulas: KpiCellData[] = [
    {
      metricId: "multicanal_receita_bruta",
      label: "Receita bruta",
      formula: "O preço de linha do Mercado Livre e o do item da Shopee; item Shopee de receita desconhecida fica fora",
      value: formatCurrency(total?.receita_bruta ?? null),
      previous: null,
      ...(semReceita > 0 ? { ressalva: `${formatCount(semReceita)} itens Shopee sem receita conhecida, fora da soma` } : {}),
    },
    {
      metricId: "multicanal_unidades",
      label: "Unidades",
      formula: "Unidades do Mercado Livre e da Shopee",
      value: formatCount(total?.unidades ?? null),
      previous: null,
    },
    {
      metricId: "multicanal_compras",
      label: "Compras",
      formula: "O pack do Mercado Livre e o pedido da Shopee que contêm o produto",
      value: formatCount(total?.compras ?? null),
      previous: null,
    },
    {
      label: "Preço médio",
      formula: "receita bruta ÷ unidades, recalculado sobre a soma; sem preço quando há item de receita desconhecida",
      value: formatCurrency(total?.preco_medio ?? null),
      previous: null,
      ...(semReceita > 0 ? { ressalva: "sem preço: há item de receita desconhecida" } : {}),
    },
  ].map((celula) =>
    // Sem total (só a loja de teste vendeu, ou nada vendeu), o "—" diz por quê.
    total === null ? { ...celula, ressalva: "nenhuma venda somável deste produto no período" } : celula,
  );

  return (
    <>
      <div className="sb-section-label sb-skud-mt0">
        <span>Entre marketplaces</span>
        <span className="sb-section-note">
          últimos {dias} dias, Mercado Livre e Shopee somados no banco · a loja de teste fica fora
        </span>
      </div>

      <div className="sb-skud-mb3">
        <KpiStrip cells={celulas} />
      </div>

      <div className="sb-skud-mb3">
        <Panel
          title="Por marketplace, conta e loja"
          subtitle="Preço médio é a razão sobre as somas de cada conta ou loja — nunca média de médias."
        >
          {contas.length === 0 ? (
            <EstadoDaTela tipo="vazio" titulo="Nenhuma venda deste produto no período, em nenhum marketplace" />
          ) : (
            <div className="sb-skud-scroll">
              <table className="sb-table sb-skud-min-44" aria-label="Vendas do produto por marketplace, conta e loja">
                <thead>
                  <tr>
                    <th>Conta ou loja</th>
                    <th>Marketplace</th>
                    <th className="sb-num">Unidades</th>
                    <th className="sb-num">Receita bruta</th>
                    <th className="sb-num">Compras</th>
                    <th className="sb-num">Preço médio</th>
                  </tr>
                </thead>
                <tbody>
                  {contas.map((conta) => (
                    <tr key={`${conta.marketplace ?? ""}:${conta.account_id ?? conta.account_name ?? ""}`}>
                      <td>
                        {conta.account_name ?? "Conta não identificada"}
                        {contaDeTeste(conta) && (
                          <span className="sb-an-meta">
                            <StatePill tone={{ tom: "atencao", label: "Teste" }} /> fora do total
                          </span>
                        )}
                      </td>
                      <td>{conta.marketplace === "SHOPEE" ? MARKETPLACE_ROTULO.shopee : MARKETPLACE_ROTULO.ml}</td>
                      <td className="sb-num">{formatCount(conta.unidades)}</td>
                      <td className="sb-num">
                        {formatCurrency(conta.receita_bruta)}
                        {conta.itens_sem_receita > 0 && (
                          <small className="sb-an-sub">{formatCount(conta.itens_sem_receita)} sem receita conhecida</small>
                        )}
                      </td>
                      <td className="sb-num">{formatCount(conta.compras)}</td>
                      <td className="sb-num">{formatCurrency(conta.preco_medio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
