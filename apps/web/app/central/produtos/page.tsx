import { toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../components/carregando";
import { FilterMenu } from "../../../components/filter-menu";
import { FilterPill } from "../../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatePill } from "../../../components/state-pill";
import { PRESETS_CENTRAL, resolverPeriodoCentral, type PeriodoCentral } from "../../../lib/central-periodo";
import { tomDaMargem } from "../../../lib/faturamento";
import { carregarLimites } from "../../../lib/limites-central";
import { currentMembership } from "../../../lib/request-membership";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../lib/format";
import {
  definicaoDaOrdem,
  formatPontos,
  formatVariacao,
  frasesDoRanking,
  lerRankingProdutos,
  ORDEM_PADRAO,
  ORDENS_RANKING,
  ordemDaUrl,
  paginaDaUrl,
  POR_PAGINA,
  type OrdemRanking,
  type ProdutoDoRanking,
  type RankingDeProdutos,
} from "../../../lib/ranking-produtos";
import { createClient } from "../../../lib/supabase/server";
import { AVISO } from "../../faturamento/numeros";

export const metadata = { title: "Ranking de produtos — Speed Bikers Gestão" };

// Sessão por cookie e RLS por quem está logado: nada aqui pode ser pré-renderizado.
export const dynamic = "force-dynamic";

/**
 * Ranking de produtos (D-402) — a rentabilidade por produto do pedido do dono
 * (seção 6): maior faturamento, lucro, margem, volume e frete, os que operam
 * no prejuízo, os que crescem e os que perderam margem, cada lista com a
 * comparação contra o período anterior e o caminho para o dashboard do SKU.
 *
 * **Uma leitura por ordem.** `get_ranking_produtos` agrega os dois períodos no
 * SQL e devolve a página pedida (50 por vez: um mês passa de mil SKUs
 * vendidos) com o resumo. O período e a comparação são os da central
 * (`lib/central-periodo.ts`, METRICS 5I), e os custos, os de `get_faturamento`.
 */

type Consulta = Record<string, string | string[] | undefined>;

interface Estado {
  readonly periodo: { preset: string } | { from: string; to: string };
  readonly conta: string | null;
  readonly ordem: OrdemRanking;
  readonly pagina: number;
}

function montarHref(estado: Estado): string {
  const search = new URLSearchParams();

  if ("preset" in estado.periodo) search.set("p", estado.periodo.preset);
  else {
    search.set("from", estado.periodo.from);
    search.set("to", estado.periodo.to);
  }
  if (estado.conta !== null) search.set("account", estado.conta);
  if (estado.ordem !== ORDEM_PADRAO) search.set("ordem", estado.ordem);
  if (estado.pagina > 1) search.set("pagina", String(estado.pagina));

  return `/central/produtos?${search.toString()}`;
}

function periodoDaUrl(periodo: PeriodoCentral): { preset: string } | { from: string; to: string } {
  return periodo.preset === null ? periodo.atual : { preset: periodo.preset };
}

function intervalo(range: { from: string; to: string }): string {
  return range.from === range.to
    ? formatBusinessDate(range.from)
    : `${formatBusinessDate(range.from)} a ${formatBusinessDate(range.to)}`;
}

export default function RankingDeProdutosPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <Shell>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando o ranking de produtos" />}>
        <RankingContent {...props} />
      </Suspense>
    </Shell>
  );
}

async function RankingContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const hoje = toSalesMetricDate(new Date());
  const periodo = resolverPeriodoCentral(query, hoje);
  const ordem = ordemDaUrl(query.ordem);
  const pagina = paginaDaUrl(query.pagina);

  const accountsResult = await supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true });
  const accounts = accountsResult.data ?? [];
  const requestedSlug = typeof query.account === "string" ? query.account : null;
  const selectedAccount = accounts.find((account) => account.slug === requestedSlug) ?? null;
  const conta = selectedAccount?.slug ?? null;
  const contaLabel = selectedAccount === null ? "Todas as contas" : selectedAccount.label;
  const estado: Estado = { periodo: periodoDaUrl(periodo), conta, ordem, pagina };

  const membership = await currentMembership();
  const leituraLimites = carregarLimites(supabase, membership.organizationId);
  const resposta = await supabase.rpc("get_ranking_produtos", {
    p_date_from: periodo.atual.from,
    p_date_to: periodo.atual.to,
    p_anterior_from: periodo.anterior.from,
    p_anterior_to: periodo.anterior.to,
    p_ordem: ordem,
    p_limite: POR_PAGINA,
    p_offset: (pagina - 1) * POR_PAGINA,
    ...(selectedAccount === null ? {} : { p_ml_account_id: selectedAccount.id }),
  });

  const titulo = (
    <PageTitle
      eyebrow="COMERCIAL / CENTRAL"
      title="Ranking de produtos"
      subtitle={
        <>
          {contaLabel} · {periodo.rotulo}: {intervalo(periodo.atual)}, comparado com {intervalo(periodo.anterior)}.
          {periodo.emAndamento && " Hoje ainda está em andamento: o crescimento compara um dia incompleto."}
        </>
      }
      aside={
        <>
          {accountsResult.error === null && accounts.length > 0 && (
            <FilterMenu
              rotulo={contaLabel}
              opcoes={[
                { href: montarHref({ ...estado, conta: null, pagina: 1 }), ativo: selectedAccount === null, label: "Todas as contas" },
                ...accounts.map((account) => ({
                  href: montarHref({ ...estado, conta: account.slug, pagina: 1 }),
                  ativo: selectedAccount?.id === account.id,
                  label: account.label,
                })),
              ]}
            />
          )}

          <FilterMenu
            rotulo={periodo.rotulo}
            opcoes={PRESETS_CENTRAL.map((preset) => ({
              href: montarHref({ ...estado, periodo: { preset: preset.id }, pagina: 1 }),
              ativo: periodo.preset === preset.id,
              label: preset.label,
            }))}
          >
            <form method="get" className="sb-periodo-form">
              {conta !== null && <input type="hidden" name="account" value={conta} />}
              {ordem !== ORDEM_PADRAO && <input type="hidden" name="ordem" value={ordem} />}
              <input
                type="date"
                name="from"
                defaultValue={periodo.preset === null ? periodo.atual.from : undefined}
                aria-label="Data inicial"
                className="sb-input"
              />
              <input
                type="date"
                name="to"
                defaultValue={periodo.preset === null ? periodo.atual.to : undefined}
                aria-label="Data final"
                className="sb-input"
              />
              <button type="submit" className="sb-button sb-button-primary">
                Aplicar período
              </button>
            </form>
          </FilterMenu>

          <Link className="sb-button" href="/central">
            Voltar à central
          </Link>
        </>
      }
    />
  );

  // Função ausente (PGRST202): a web da `main` chega à produção antes de a
  // migration passar pelo workflow — o precedente de D-363.
  if (resposta.error !== null) {
    return (
      <>
        {titulo}
        {resposta.error.code === "PGRST202" ? (
          <div className="sb-note">
            <span>SENDO ATIVADO</span>
            <p>
              O ranking de produtos está sendo ativado neste ambiente: o banco ainda não recebeu a função de D-402. Assim
              que a migração for aplicada, esta tela passa a listar os produtos.
            </p>
          </div>
        ) : (
          <p role="alert" style={AVISO}>
            Não foi possível carregar o ranking de produtos: {resposta.error.message}
          </p>
        )}
      </>
    );
  }

  const ranking = lerRankingProdutos(resposta.data);

  if (ranking === null) {
    return (
      <>
        {titulo}
        <p role="alert" style={AVISO}>
          O ranking respondeu num formato que esta tela não reconhece — nada foi mostrado.
        </p>
      </>
    );
  }

  return (
    <>
      {titulo}

      {accountsResult.error !== null && (
        <p role="alert" style={AVISO}>
          Não foi possível carregar as contas: o filtro de conta está indisponível.
        </p>
      )}

      {periodo.invalido && (
        <p role="alert" style={AVISO}>
          Período personalizado inválido — mostrando {periodo.rotulo.toLowerCase()}.
        </p>
      )}

      <KpiStrip cells={celulasDoResumo(ranking, estado)} />

      <Resumo ranking={ranking} estado={estado} />

      <Lista ranking={ranking} estado={estado} margemMinima={(await leituraLimites).margemMinima} />

      <ComoCalcula ranking={ranking} />
    </>
  );
}

function celulasDoResumo(r: RankingDeProdutos, estado: Estado): KpiCellData[] {
  const s = r.resumo;

  return [
    {
      metricId: "skus_distintos_vendidos",
      label: "Produtos vendidos",
      formula: "SKUs distintos com pedido válido no período",
      value: formatCount(s.skus_com_venda),
      previous: null,
      ressalva: `${formatCount(s.skus_cobertos)} com resultado conhecido`,
    },
    {
      metricId: "resultado_venda",
      label: "Resultado das vendas",
      formula: "receita − comissão − frete − custo, nos pedidos cobertos",
      value: formatCurrency(s.resultado_venda),
      previous: null,
      href: montarHref({ ...estado, ordem: "lucro", pagina: 1 }),
    },
    {
      metricId: "resultado_venda",
      label: "No prejuízo",
      formula: "produtos com resultado negativo no período",
      value: formatCount(s.skus_prejuizo),
      previous: null,
      ressalva: s.prejuizo === null ? "nenhum prejuízo no período" : `${formatCurrency(s.prejuizo)} somados`,
      href: montarHref({ ...estado, ordem: "prejuizo", pagina: 1 }),
      tom: s.skus_prejuizo > 0 ? "perigo" : "neutro",
      ...(s.skus_prejuizo > 0 ? { destaque: "perigo" as const } : {}),
    },
    {
      metricId: "concentracao_resultado",
      label: "Metade do resultado",
      formula: "menor número de produtos, dos de maior resultado, que soma metade do resultado de todos",
      value: s.skus_metade_do_resultado === null ? "—" : `${formatCount(s.skus_metade_do_resultado)} produtos`,
      previous: null,
      ressalva:
        s.skus_metade_do_resultado === null || s.skus_com_venda === 0
          ? "sem resultado positivo no período"
          : `${formatPercent(s.skus_metade_do_resultado / s.skus_com_venda)} dos vendidos`,
      href: montarHref({ ...estado, ordem: "lucro", pagina: 1 }),
    },
    {
      metricId: "variacao_receita_produto",
      label: "Cresceram 30% ou mais",
      formula: "receita contra o período anterior, só produtos com 5 pedidos ou mais nos dois",
      value: formatCount(s.skus_crescendo),
      previous: null,
      ressalva: `de ${formatCount(s.skus_comparaveis)} comparáveis`,
      href: montarHref({ ...estado, ordem: "crescimento", pagina: 1 }),
    },
  ];
}

function Resumo({ ranking, estado }: { ranking: RankingDeProdutos; estado: Estado }): ReactNode {
  const frases = frasesDoRanking(ranking.resumo);

  if (frases.length === 0) return null;

  return (
    <Panel title="O que os números dizem" subtitle="Escrito a partir do ranking do período; cada frase abre a lista dela.">
      <ul className="sb-panel-body sb-rank-frases">
        {frases.map((f) => (
          <li key={f.ordem}>
            <span>{f.texto}</span>{" "}
            <Link href={montarHref({ ...estado, ordem: f.ordem, pagina: 1 })}>ver lista</Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** A coluna que a ordem ordena, e em que direção — para `aria-sort` e o destaque. */
function colunaDaOrdem(ordem: OrdemRanking): { coluna: string; direcao: "descending" | "ascending" } {
  switch (ordem) {
    case "receita":
      return { coluna: "receita", direcao: "descending" };
    case "lucro":
      return { coluna: "resultado", direcao: "descending" };
    case "prejuizo":
      return { coluna: "resultado", direcao: "ascending" };
    case "margem":
      return { coluna: "margem", direcao: "descending" };
    case "menor_margem":
      return { coluna: "margem", direcao: "ascending" };
    case "volume":
      return { coluna: "unidades", direcao: "descending" };
    case "frete":
      return { coluna: "frete", direcao: "descending" };
    // As variações moram embaixo da receita e da margem, na mesma célula.
    case "crescimento":
      return { coluna: "receita", direcao: "descending" };
    case "queda_margem":
      return { coluna: "margem", direcao: "ascending" };
  }
}

const COLUNAS: readonly { readonly id: string; readonly rotulo: string; readonly titulo: string }[] = [
  { id: "unidades", rotulo: "Unid.", titulo: "unidades vendidas no período" },
  { id: "receita", rotulo: "Receita", titulo: "receita bruta do período e, embaixo, contra o anterior (5 pedidos ou mais nos dois)" },
  { id: "taxas", rotulo: "Comissão", titulo: "comissão do Mercado Livre (sale_fee × unidades), todos os pedidos" },
  { id: "frete", rotulo: "Frete", titulo: "frete pago pelo vendedor, pedidos cobertos" },
  { id: "custo", rotulo: "Custo", titulo: "custo do produto na data da venda, pedidos cobertos" },
  { id: "resultado", rotulo: "Resultado", titulo: "receita − comissão − frete − custo, pedidos cobertos" },
  { id: "margem", rotulo: "Margem", titulo: "resultado ÷ receita, pedidos cobertos e, embaixo, contra o anterior em pontos (5 cobertos nos dois)" },
];

function Lista({
  ranking,
  estado,
  margemMinima,
}: {
  ranking: RankingDeProdutos;
  estado: Estado;
  margemMinima: number;
}): ReactNode {
  const definicao = definicaoDaOrdem(ranking.ordem);
  const { coluna, direcao } = colunaDaOrdem(ranking.ordem);
  const paginas = Math.max(1, Math.ceil(ranking.total / POR_PAGINA));
  const inicio = (estado.pagina - 1) * POR_PAGINA;
  // Com alíquota cadastrada (D-395), o resultado após imposto ganha coluna; sem, ela não aparece.
  const comImposto = ranking.itens.some((p) => p.resultado_apos_imposto !== null);

  return (
    <Panel
      title={definicao.rotulo}
      subtitle={`${definicao.descricao} ${formatCount(ranking.total)} ${ranking.total === 1 ? "produto" : "produtos"}.`}
    >
      <div className="sb-panel-body">
        <nav className="sb-sinal-filtros" aria-label="Ordem do ranking">
          {ORDENS_RANKING.map((o) => (
            <FilterPill key={o.id} href={montarHref({ ...estado, ordem: o.id, pagina: 1 })} active={o.id === ranking.ordem}>
              {o.rotulo}
            </FilterPill>
          ))}
        </nav>

        {ranking.itens.length === 0 ? (
          <p className="sb-empty">{vazio(ranking.ordem, estado.pagina)}</p>
        ) : (
          <div className="sb-central-tabela">
            <table className="sb-table sb-rank-tabela">
              <thead>
                <tr>
                  <th className="sb-num">#</th>
                  <th>Produto</th>
                  {COLUNAS.map((c) => (
                    <th
                      key={c.id}
                      className={c.id === coluna ? "sb-num sb-rank-ordenada" : "sb-num"}
                      title={c.titulo}
                      aria-sort={c.id === coluna ? direcao : undefined}
                    >
                      {c.rotulo}
                    </th>
                  ))}
                  {comImposto && (
                    <th className="sb-num" title="resultado − imposto pela alíquota vigente no dia de cada pedido">
                      Após imposto
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {ranking.itens.map((p, i) => (
                  <Linha
                    key={p.sku_id}
                    produto={p}
                    posicao={inicio + i + 1}
                    coluna={coluna}
                    comImposto={comImposto}
                    margemMinima={margemMinima}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {paginas > 1 && (
          <nav className="sb-abc-pagination" aria-label="Paginação do ranking">
            {estado.pagina > 1 && (
              <FilterPill href={montarHref({ ...estado, pagina: estado.pagina - 1 })} active={false}>
                ← Anterior
              </FilterPill>
            )}
            <span>
              Página {estado.pagina} de {paginas}
            </span>
            {estado.pagina < paginas && (
              <FilterPill href={montarHref({ ...estado, pagina: estado.pagina + 1 })} active={false}>
                Próxima →
              </FilterPill>
            )}
          </nav>
        )}
      </div>
    </Panel>
  );
}

function vazio(ordem: OrdemRanking, pagina: number): string {
  if (pagina > 1) return "Esta página passou do fim da lista.";

  switch (ordem) {
    case "prejuizo":
      return "Nenhum produto vendeu com prejuízo neste período.";
    case "queda_margem":
      return "Nenhum produto comparável perdeu margem contra o período anterior.";
    case "crescimento":
      return "Nenhum produto tem 5 pedidos ou mais nos dois períodos: sem base para comparar crescimento.";
    case "margem":
      return "Nenhum produto com 3 pedidos cobertos ou mais no período.";
    default:
      return "Nenhum produto vendido neste período.";
  }
}

function Linha({
  produto: p,
  posicao,
  coluna,
  comImposto,
  margemMinima,
}: {
  produto: ProdutoDoRanking;
  posicao: number;
  coluna: string;
  comImposto: boolean;
  margemMinima: number;
}): ReactNode {
  const classe = (id: string): string => (id === coluna ? "sb-num sb-rank-ordenada" : "sb-num");

  return (
    <tr>
      <td className="sb-num">{posicao}</td>
      <td>
        <Link className="sb-entity" href={`/skus/${p.sku_id}`} title={p.title ?? p.sku}>
          {p.title ?? p.sku}
        </Link>
        <span className="sb-central-motivo">
          SKU {p.sku} · {formatCount(p.pedidos)} {p.pedidos === 1 ? "pedido" : "pedidos"}
          {p.pedidos_cobertos < p.pedidos && `, ${formatCount(p.pedidos_cobertos)} cobertos`}
        </span>
      </td>
      <td className={classe("unidades")}>{formatCount(p.unidades)}</td>
      <td className={classe("receita")}>
        {formatCurrency(p.receita_bruta)}
        {p.variacao_receita !== null && (
          <span className="sb-central-motivo">{formatVariacao(p.variacao_receita)} contra o anterior</span>
        )}
      </td>
      <td className={classe("taxas")}>{formatCurrency(p.taxas_ml)}</td>
      <td className={classe("frete")}>
        {formatCurrency(p.frete_vendedor)}
        {p.frete_sobre_receita !== null && <span className="sb-central-motivo">{formatPercent(p.frete_sobre_receita)} da receita</span>}
      </td>
      <td className={classe("custo")} title={p.custo_atual ? "inclui pedido com o custo atual, sem histórico anterior à venda" : undefined}>
        {formatCurrency(p.custo_produtos)}
        {p.custo_atual && " *"}
      </td>
      <td className={classe("resultado")}>{formatCurrency(p.resultado_venda)}</td>
      <td className={classe("margem")}>
        {p.margem_venda === null ? (
          <span className="sb-texto-suave">sem cobertura</span>
        ) : (
          <StatePill tone={{ tom: tomDaMargem(p.margem_venda, margemMinima), label: formatPercent(p.margem_venda) }} />
        )}
        {p.variacao_margem !== null && <span className="sb-central-motivo">{formatPontos(p.variacao_margem)}</span>}
      </td>
      {comImposto && (
        <td className="sb-num">
          {formatCurrency(p.resultado_apos_imposto)}
          {p.margem_apos_imposto !== null && <span className="sb-central-motivo">{formatPercent(p.margem_apos_imposto)}</span>}
        </td>
      )}
    </tr>
  );
}

function ComoCalcula({ ranking }: { ranking: RankingDeProdutos }): ReactNode {
  const { periodo } = ranking;

  return (
    <Panel title="Como o ranking é calculado">
      <div className="sb-panel-body sb-sinal-metodo">
        <p>
          <strong>Os mesmos números do faturamento.</strong> Receita, comissão, frete e custo saem das mesmas regras de
          <Link href="/faturamento"> /faturamento</Link>: resultado e margem só nos <strong>pedidos cobertos</strong> —
          frete observado, custo conhecido e uma linha de item. Pedido com vários produtos não entra no resultado de
          nenhum deles, porque o frete é do pacote. O custo é o da data da venda; com * é o atual, por não haver
          histórico anterior.
        </p>
        <p>
          <strong>A comparação</strong> é com {formatBusinessDate(periodo.anterior_inicio)} a{" "}
          {formatBusinessDate(periodo.anterior_fim)}, a mesma da central. Crescimento só com 5 pedidos ou mais nos dois
          períodos, e variação de margem só com 5 pedidos cobertos nos dois: com menos, uma venda a mais vira +100%.
        </p>
        <p>
          <strong>O que não está aqui:</strong> gasto com Ads por produto — a API de Product Ads não diz que produtos cada
          campanha vendeu, e a de anúncio foi desligada pelo Mercado Livre; o investimento aparece por campanha em{" "}
          <Link href="/central/ads">Sinais de Ads</Link>. Custos fixos, devoluções e custo do Mercado Pago também ficam
          fora: é resultado da venda, não lucro líquido. O imposto entra numa coluna própria quando há alíquota
          cadastrada em <Link href="/central/metas">Metas e imposto</Link>.
        </p>
      </div>
    </Panel>
  );
}
