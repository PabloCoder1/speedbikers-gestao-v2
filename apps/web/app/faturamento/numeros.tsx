import Link from "next/link";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { Panel } from "../../components/panel";
import { StatePill } from "../../components/state-pill";
import { TOM } from "../../components/tone";
import {
  lerFaturamento,
  montarCascata,
  participacao,
  tomDaMargem,
  type ContaFaturamento,
  type ResumoFaturamento,
  type SkuFaturamento,
} from "../../lib/faturamento";
import { formatCount, formatCurrency, formatPercent } from "../../lib/format";
import type { PeriodRange } from "../../lib/period";
import { BarrasDiarias } from "./barras-diarias";
import { Cascata } from "./cascata";

/** O pedaço de `PostgrestResponse` que a tela lê. */
export interface RespostaRpc {
  data: unknown;
  error: { message: string } | null;
}

export const AVISO: React.CSSProperties = { margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-danger)" };

const BLOCO: React.CSSProperties = { marginTop: "var(--sb-space-3)" };

function celulasDoResumo(resumo: ResumoFaturamento, anterior: ResumoFaturamento | null): KpiCellData[] {
  const antes = (valor: (r: ResumoFaturamento) => string): string | null => (anterior === null ? null : valor(anterior));
  const tom = tomDaMargem(resumo.margem_venda);
  const cobertura = participacao(resumo.receita_coberta, resumo.receita_bruta);

  return [
    {
      metricId: "receita_bruta",
      label: "Receita bruta",
      formula: "SUM(quantidade × preço unitário) dos pedidos pagos ou parcialmente reembolsados",
      value: formatCurrency(resumo.receita_bruta),
      previous: antes((r) => formatCurrency(r.receita_bruta)),
      ressalva: `${formatCount(resumo.pedidos)} pedidos · ${formatCount(resumo.unidades)} unidades`,
    },
    {
      metricId: "resultado_venda",
      label: "Resultado da venda",
      formula: "receita − comissão − frete do vendedor − custo dos produtos, sobre pedidos cobertos",
      value: formatCurrency(resumo.resultado_venda),
      previous: antes((r) => formatCurrency(r.resultado_venda)),
      ressalva:
        resumo.pedidos_cobertos === 0
          ? "nenhum pedido coberto no período"
          : `sobre ${formatPercent(cobertura)} da receita (${formatCount(resumo.pedidos_cobertos)} pedidos)`,
    },
    {
      metricId: "margem_venda",
      label: "Margem sobre a venda",
      formula: "resultado_venda ÷ receita dos mesmos pedidos cobertos",
      value: formatPercent(resumo.margem_venda),
      previous: antes((r) => formatPercent(r.margem_venda)),
      ressalva: "não é lucro líquido: impostos ficam fora",
      ...(tom === "perigo" || tom === "atencao" ? { destaque: tom } : {}),
    },
    {
      metricId: "taxas_ml",
      label: "Comissão do Mercado Livre",
      formula: "SUM(order_items.sale_fee × quantity) sobre vendas válidas",
      value: formatCurrency(resumo.taxas_ml),
      previous: antes((r) => formatCurrency(r.taxas_ml)),
      ressalva: `${formatPercent(resumo.comissao_percentual)} da receita`,
    },
    {
      metricId: "ticket_medio",
      label: "Ticket médio",
      formula: "receita_bruta ÷ compras (pack, com o pedido como reserva)",
      value: formatCurrency(resumo.ticket_medio),
      previous: antes((r) => formatCurrency(r.ticket_medio)),
      ressalva: `${formatCount(resumo.compras)} compras`,
    },
  ];
}

/**
 * Os números do período — tudo que depende de `get_faturamento`, fora da página
 * para a página só cuidar de filtro e streaming.
 */
export async function Numeros({
  leituras,
  range,
  todasAsContas,
}: {
  leituras: Promise<readonly [RespostaRpc, RespostaRpc]>;
  range: PeriodRange;
  todasAsContas: boolean;
}): Promise<ReactNode> {
  const [atualResult, anteriorResult] = await leituras;

  if (atualResult.error !== null) {
    return (
      <p role="alert" style={AVISO}>
        Não foi possível carregar o faturamento: {atualResult.error.message}
      </p>
    );
  }

  const atual = lerFaturamento(atualResult.data);

  if (atual === null) {
    return (
      <p role="alert" style={AVISO}>
        A resposta do faturamento veio num formato que esta tela não reconhece — nenhum número foi mostrado para não
        mostrar número errado.
      </p>
    );
  }

  // Falhar o período anterior não pode parecer "o período anterior não vendeu"
  // (D-067): a comparação sai, e o aviso diz por quê.
  const anterior = anteriorResult.error === null ? (lerFaturamento(anteriorResult.data)?.resumo ?? null) : null;
  const { resumo } = atual;
  const cascata = montarCascata(resumo);
  const tomMargem = tomDaMargem(resumo.margem_venda);

  return (
    <>
      {anterior === null && (
        <p role="alert" style={AVISO}>
          O período anterior não carregou — a comparação foi omitida, e isso não é zero.
        </p>
      )}

      <KpiStrip ancora cells={celulasDoResumo(resumo, anterior)} />

      <div className="sb-lower-grid">
        <Panel
          title="Para onde vai o dinheiro"
          subtitle={
            cascata === null
              ? "Da receita ao resultado, pedido a pedido."
              : `${formatCount(resumo.pedidos_cobertos)} pedidos cobertos, ${formatPercent(participacao(resumo.receita_coberta, resumo.receita_bruta))} da receita do período — frete observado, custo conhecido e um produto por pedido.`
          }
        >
          {cascata === null ? (
            <p className="sb-empty">
              Nenhum pedido deste período tem frete e custo observados ao mesmo tempo. O frete do vendedor é capturado desde
              14/09/2026, e o custo depende de o anúncio estar vinculado a um produto com custo cadastrado.
            </p>
          ) : (
            <>
              <Cascata degraus={cascata} />
              <p className="sb-cascata-margem">
                Margem sobre a venda{" "}
                <strong style={{ color: tomMargem === "neutro" ? undefined : TOM[tomMargem].color }}>
                  {formatPercent(resumo.margem_venda)}
                </strong>{" "}
                <span>= resultado ÷ receita dos mesmos pedidos</span>
              </p>
            </>
          )}
        </Panel>

        <Panel title="Custos da venda" subtitle="Cada valor sobre os pedidos em que ele foi observado.">
          <ul className="sb-valores">
            <li title="taxas_ml ÷ receita_bruta">
              <span className="sb-valores-rotulo">Comissão sobre a receita</span>
              <strong className="sb-valores-valor">{formatPercent(resumo.comissao_percentual)}</strong>
              <span className="sb-valores-nota">
                {formatCurrency(resumo.taxas_ml)} de comissão de venda · taxa fixa e parcelamento ficam fora
              </span>
            </li>
            <li title="frete_vendedor ÷ pedidos com frete observado">
              <span className="sb-valores-rotulo">Frete médio por pedido</span>
              <strong className="sb-valores-valor">{formatCurrency(resumo.frete_medio_pedido)}</strong>
              <span className="sb-valores-nota">
                {formatCurrency(resumo.frete_vendedor)} em {formatCount(resumo.pedidos_com_custos)} pedidos com frete
                observado
              </span>
            </li>
            <li title="receita − comissão − frete, sobre pedidos com frete observado">
              <span className="sb-valores-rotulo">Recebido após o Mercado Livre</span>
              <strong className="sb-valores-valor">{formatCurrency(resumo.margem_operacional)}</strong>
              <span className="sb-valores-nota">
                {formatPercent(participacao(resumo.margem_operacional, resumo.receita_com_custos))} da receita desses mesmos
                pedidos · antes do custo do produto
              </span>
            </li>
            <li title="custo na data da venda, sobre pedidos cobertos">
              <span className="sb-valores-rotulo">Custo dos produtos</span>
              <strong className="sb-valores-valor">{formatCurrency(resumo.custo_produtos)}</strong>
              <span className="sb-valores-nota">
                {formatPercent(participacao(resumo.custo_produtos, resumo.receita_coberta))} da receita coberta
              </span>
            </li>
            <li title="receita_bruta ÷ unidades">
              <span className="sb-valores-rotulo">Preço médio por unidade</span>
              <strong className="sb-valores-valor">{formatCurrency(resumo.preco_medio)}</strong>
              <span className="sb-valores-nota">{formatCount(resumo.unidades)} unidades vendidas</span>
            </li>
            <li title="amounts.seller dos pedidos com frete observado">
              <span className="sb-valores-rotulo">Desconto do vendedor</span>
              <strong className="sb-valores-valor">{formatCurrency(resumo.desconto_vendedor)}</strong>
              <span className="sb-valores-nota">informativo: já está dentro do preço vendido e não é subtraído</span>
            </li>
          </ul>
        </Panel>
      </div>

      {atual.diario !== null && (
        <div style={BLOCO}>
          <Panel
            title="Receita e margem por dia"
            subtitle="A receita é de todos os pedidos; a margem, dos pedidos cobertos de cada dia. Passe o ponteiro sobre um dia para ler os valores."
          >
            {atual.diario.length === 0 ? (
              <p className="sb-empty">Nenhuma venda válida neste período.</p>
            ) : (
              <BarrasDiarias dias={atual.diario} rangeFrom={range.from} rangeTo={range.to} />
            )}
          </Panel>
        </div>
      )}

      {todasAsContas && atual.porConta !== null && atual.porConta.length > 0 && (
        <div style={BLOCO}>
          <TabelaContas contas={atual.porConta} />
        </div>
      )}

      {atual.produtos !== null && (
        <div className="sb-pair-grid">
          <Panel
            title="Produtos que mais faturaram"
            subtitle={`top ${String(atual.produtos.maiorReceita.length)} de ${formatCount(atual.produtos.skusComVenda)} produtos com venda · margem sobre os pedidos cobertos de cada um`}
          >
            {atual.produtos.maiorReceita.length === 0 ? (
              <p className="sb-empty">Nenhum produto vinculado vendeu neste período.</p>
            ) : (
              <TabelaProdutos linhas={atual.produtos.maiorReceita} modo="receita" />
            )}
          </Panel>

          <Panel
            title="Margem abaixo de 10%"
            subtitle={
              atual.produtos.skusAbaixoDaMargem === 0
                ? "nenhum produto coberto ficou abaixo de 10%"
                : `${formatCount(atual.produtos.skusAbaixoDaMargem)} produtos abaixo de 10%, ${formatCount(atual.produtos.skusMargemNegativa)} com margem negativa · da pior para a melhor`
            }
          >
            {atual.produtos.menorMargem.length === 0 ? (
              <p className="sb-empty">Nenhum produto coberto com margem abaixo de 10% neste período.</p>
            ) : (
              <TabelaProdutos linhas={atual.produtos.menorMargem} modo="margem" />
            )}
          </Panel>
        </div>
      )}

      <div style={BLOCO}>
        <Panel
          title="O que estes números cobrem"
          subtitle="Receita, comissão e ticket valem para todos os pedidos válidos. Resultado e margem, só para os cobertos."
        >
          <div className="sb-panel-body">
            <div className="sb-stat-grid">
              <div className="sb-stat">
                <span className="sb-stat-label">Pedidos cobertos</span>
                <strong className="sb-stat-value">
                  {formatCount(resumo.pedidos_cobertos)} de {formatCount(resumo.pedidos)}
                </strong>
                <span className="sb-stat-note">
                  {formatPercent(participacao(resumo.receita_coberta, resumo.receita_bruta))} da receita · entram no
                  resultado e na margem
                </span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-label">Sem frete observado</span>
                <strong className="sb-stat-value">{formatCount(resumo.pedidos_sem_frete)}</strong>
                <span className="sb-stat-note">o frete do vendedor é capturado desde 14/09/2026</span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-label">Sem produto vinculado</span>
                <strong className="sb-stat-value">{formatCount(resumo.pedidos_sem_sku)}</strong>
                <span className="sb-stat-note">
                  sem produto não há custo · <Link href="/vinculacoes">vincular anúncios</Link>
                </span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-label">Produto sem custo</span>
                <strong className="sb-stat-value">{formatCount(resumo.pedidos_sem_custo)}</strong>
                <span className="sb-stat-note">
                  custo vazio ou zero não é somado · <Link href="/produtos">ver produtos</Link>
                </span>
              </div>
            </div>

            <div className="sb-note sb-faturamento-nota">
              <span>COMO LER</span>
              <p>
                <strong>Resultado não é lucro líquido.</strong> Impostos, taxa fixa por pedido, parcelamento, custo do
                Mercado Pago, reembolsos posteriores e Ads ficam fora.
              </p>
              <p>
                O desconto do vendedor já está dentro do preço vendido — o Mercado Livre cobra a comissão sobre esse preço
                — e por isso não é subtraído de novo.
              </p>
              <p>
                O custo é o da data da venda, pelo histórico de custo.{" "}
                {resumo.pedidos_custo_atual === 0
                  ? "Todos os pedidos cobertos tinham histórico."
                  : `${formatCount(resumo.pedidos_custo_atual)} pedidos cobertos usaram o custo atual, por não haver histórico anterior à venda.`}
              </p>
              {resumo.pedidos_multi_item > 0 && (
                <p>
                  {formatCount(resumo.pedidos_multi_item)} pedidos com mais de um produto ficaram fora da margem: o frete
                  é do pedido e não se divide entre produtos.
                </p>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}

function PilulaDaMargem({ margem, custoAtual }: { margem: number | null; custoAtual: boolean }): ReactNode {
  if (margem === null) return <span className="sb-texto-suave">sem cobertura</span>;

  return (
    <span title={custoAtual ? "inclui pedido com o custo atual, sem histórico anterior à venda" : undefined}>
      <StatePill tone={{ tom: tomDaMargem(margem), label: `${formatPercent(margem)}${custoAtual ? " *" : ""}` }} />
    </span>
  );
}

function CelulaProduto({ linha }: { linha: SkuFaturamento }): ReactNode {
  return (
    <td>
      <Link className="sb-entity" href={`/skus/${linha.sku_id}`}>
        {linha.title ?? linha.sku}
      </Link>
      <span className="sb-mono sb-faturamento-sku">SKU {linha.sku}</span>
    </td>
  );
}

function TabelaProdutos({ linhas, modo }: { linhas: readonly SkuFaturamento[]; modo: "receita" | "margem" }): ReactNode {
  return (
    <div className="sb-faturamento-tabela">
      <table className="sb-table">
        <thead>
          <tr>
            <th>Produto</th>
            {modo === "receita" ? (
              <>
                <th className="sb-num">Unidades</th>
                <th className="sb-num">Receita</th>
              </>
            ) : (
              <>
                <th className="sb-num">Receita coberta</th>
                <th className="sb-num">Custo</th>
              </>
            )}
            <th className="sb-num">Resultado</th>
            <th className="sb-num">Margem</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.sku_id}>
              <CelulaProduto linha={linha} />
              {modo === "receita" ? (
                <>
                  <td className="sb-num">{formatCount(linha.unidades)}</td>
                  <td className="sb-num">{formatCurrency(linha.receita_bruta)}</td>
                </>
              ) : (
                <>
                  <td className="sb-num">{formatCurrency(linha.receita_coberta)}</td>
                  <td className="sb-num">{formatCurrency(linha.custo_produtos)}</td>
                </>
              )}
              <td className="sb-num">{formatCurrency(linha.resultado_venda)}</td>
              <td className="sb-num">
                <PilulaDaMargem margem={linha.margem_venda} custoAtual={linha.custo_atual} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabelaContas({ contas }: { contas: readonly ContaFaturamento[] }): ReactNode {
  return (
    <Panel
      title="Por conta"
      subtitle="Frete e recebido sobre os pedidos com frete observado; resultado e margem sobre os pedidos cobertos."
    >
      <div className="sb-faturamento-tabela">
        <table className="sb-table">
          <thead>
            <tr>
              <th>Conta</th>
              <th className="sb-num">Pedidos</th>
              <th className="sb-num">Receita</th>
              <th className="sb-num">Comissão</th>
              <th className="sb-num">Frete</th>
              <th className="sb-num">Recebido</th>
              <th className="sb-num">Resultado</th>
              <th className="sb-num">Margem</th>
              <th className="sb-num">Cobertura</th>
            </tr>
          </thead>
          <tbody>
            {contas.map((conta) => (
              <tr key={conta.ml_account_id}>
                <td>
                  <strong>{conta.conta}</strong>
                </td>
                <td className="sb-num">{formatCount(conta.pedidos)}</td>
                <td className="sb-num">{formatCurrency(conta.receita_bruta)}</td>
                <td className="sb-num">{formatCurrency(conta.taxas_ml)}</td>
                <td className="sb-num">{formatCurrency(conta.frete_vendedor)}</td>
                <td className="sb-num">{formatCurrency(conta.margem_operacional)}</td>
                <td className="sb-num">{formatCurrency(conta.resultado_venda)}</td>
                <td className="sb-num">
                  <PilulaDaMargem margem={conta.margem_venda} custoAtual={false} />
                </td>
                <td className="sb-num" title="pedidos cobertos ÷ pedidos">
                  {formatPercent(participacao(conta.pedidos_cobertos, conta.pedidos))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
