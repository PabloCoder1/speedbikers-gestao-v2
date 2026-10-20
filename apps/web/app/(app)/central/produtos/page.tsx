import { toSalesMetricDate } from "@sb/domain";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { CarregandoConteudo } from "../../../../components/carregando";
import { FormularioFiltro } from "../../../../components/formulario-filtro";
import { FilterMenu } from "../../../../components/filter-menu";
import { FilterPill } from "../../../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../../../components/kpi-strip";
import { Glossario } from "../../../../components/ajuda";
import { Panel } from "../../../../components/panel";
import { StatePill } from "../../../../components/state-pill";
import {
  escreverPeriodoNaUrl,
  periodoDaUrl,
  PRESETS_CENTRAL,
  resolverPeriodoCentral,
  rotuloDoIntervalo,
  type PeriodoNaUrl,
} from "../../../../lib/central-periodo";
import { tomDaMargem } from "../../../../lib/faturamento";
import { carregarLimites } from "../../../../lib/limites-central";
import { currentMembership } from "../../../../lib/request-membership";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../../../lib/format";
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
} from "../../../../lib/ranking-produtos";
import { createClient } from "../../../../lib/supabase/server";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { AvisoDePeriodoInvalido, CabecalhoDaCentral, funcaoAusente, SendoAtivado, type RespostaComCodigo } from "../comum";

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
  readonly periodo: PeriodoNaUrl;
  readonly conta: string | null;
  readonly ordem: OrdemRanking;
  readonly pagina: number;
}

function montarHref(estado: Estado): string {
  const search = new URLSearchParams();

  escreverPeriodoNaUrl(search, estado.periodo);
  if (estado.conta !== null) search.set("account", estado.conta);
  if (estado.ordem !== ORDEM_PADRAO) search.set("ordem", estado.ordem);
  if (estado.pagina > 1) search.set("pagina", String(estado.pagina));

  return `/central/produtos?${search.toString()}`;
}

export default function RankingDeProdutosPage(props: { searchParams: Promise<Consulta> }): ReactNode {
  return (
    <>
      <Suspense fallback={<CarregandoConteudo rotulo="Carregando o ranking de produtos" />}>
        <RankingContent {...props} />
      </Suspense>
    </>
  );
}

async function RankingContent({ searchParams }: { searchParams: Promise<Consulta> }): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const hoje = toSalesMetricDate(new Date());
  const periodo = resolverPeriodoCentral(query, hoje);
  const ordem = ordemDaUrl(query.ordem);
  const pagina = paginaDaUrl(query.pagina);

  const requestedSlug = typeof query.account === "string" ? query.account : null;
  const argumentos = {
    p_date_from: periodo.atual.from,
    p_date_to: periodo.atual.to,
    p_anterior_from: periodo.anterior.from,
    p_anterior_to: periodo.anterior.to,
    p_ordem: ordem,
    p_limite: POR_PAGINA,
    p_offset: (pagina - 1) * POR_PAGINA,
  };

  // Sem fila (UX_SYSTEM §6, bloco 3): contas e organização saem juntas, e sem
  // conta na URL o ranking não espera nenhuma das duas. O `Promise.resolve`
  // dispara a consulta agora; o construtor do PostgREST só sai quando é lido.
  const leituraContas = supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true });
  const rankingSemConta = requestedSlug === null ? Promise.resolve(supabase.rpc("get_ranking_produtos", argumentos)) : null;
  // Como na central: se contas ou organização lançarem antes, a leitura não fica
  // sem dono; quem a lê abaixo ainda recebe a falha.
  void rankingSemConta?.catch(() => undefined);
  const [accountsResult, membership] = await Promise.all([leituraContas, currentMembership()]);
  const accounts = accountsResult.data ?? [];
  const selectedAccount = accounts.find((account) => account.slug === requestedSlug) ?? null;
  const conta = selectedAccount?.slug ?? null;
  const contaLabel = selectedAccount === null ? "Todas as contas" : selectedAccount.label;
  const estado: Estado = { periodo: periodoDaUrl(periodo), conta, ordem, pagina };

  const leituraLimites = carregarLimites(supabase, membership.organizationId);
  // Só os números esperam o ranking (D-520): o título, as abas e os filtros
  // pintam com as contas. Com conta na URL, a leitura sai agora, com o slug
  // resolvido; sem conta, ela já saiu lá em cima.
  const leituraRanking =
    rankingSemConta ??
    Promise.resolve(
      supabase.rpc("get_ranking_produtos", {
        ...argumentos,
        ...(selectedAccount === null ? {} : { p_ml_account_id: selectedAccount.id }),
      }),
    );

  // As abas da Central levam o recorte aplicado; o período recusado não viaja (UX_SYSTEM §6, bloco 1).
  const titulo = (
    <CabecalhoDaCentral
      tela="produtos"
      consulta={{ ...(periodo.invalido ? {} : query), account: conta ?? undefined }}
      titulo="Ranking de produtos"
      subtitulo={
        <>
          {contaLabel} · {periodo.rotulo}: {rotuloDoIntervalo(periodo.atual)}, comparado com {rotuloDoIntervalo(periodo.anterior)}.
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
            <FormularioFiltro action="/central/produtos" className="sb-periodo-form">
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
            </FormularioFiltro>
          </FilterMenu>
        </>
      }
    />
  );

  return (
    <>
      {titulo}

      {accountsResult.error !== null && (
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar as contas"
          descricao="O filtro de conta está indisponível."
          detalhe={accountsResult.error.message}
          acao={{ href: montarHref(estado), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {periodo.invalido && <AvisoDePeriodoInvalido rotulo={periodo.rotulo} />}

      <Suspense fallback={<CarregandoConteudo rotulo="Carregando o ranking de produtos" comTitulo={false} />}>
        <CorpoDoRanking leitura={leituraRanking} estado={estado} leituraLimites={leituraLimites} />
      </Suspense>
    </>
  );
}

/**
 * Os números do ranking, que esperam o `get_ranking_produtos` (D-520). A
 * falha, a função ausente e o formato desconhecido ficam aqui, abaixo do
 * título já pintado; o "Tentar de novo" é a mesma URL, com o recorte inteiro.
 */
async function CorpoDoRanking({
  leitura,
  estado,
  leituraLimites,
}: {
  leitura: PromiseLike<RespostaComCodigo>;
  estado: Estado;
  leituraLimites: ReturnType<typeof carregarLimites>;
}): Promise<ReactNode> {
  const resposta = await leitura;

  if (resposta.error !== null) {
    return funcaoAusente(resposta.error) ? (
      <SendoAtivado>
        O ranking de produtos está sendo ativado neste ambiente: o banco ainda não recebeu a função de D-402. Assim que
        a migração for aplicada, esta tela passa a listar os produtos.
      </SendoAtivado>
    ) : (
      <EstadoDaTela
        tipo="erro"
        titulo="Não foi possível carregar o ranking de produtos"
        detalhe={resposta.error.message}
        acao={{ href: montarHref(estado), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
      />
    );
  }

  const ranking = lerRankingProdutos(resposta.data);

  if (ranking === null) {
    return (
      <EstadoDaTela
        tipo="erro"
        titulo="O ranking respondeu num formato que esta tela não reconhece"
        descricao="Nada foi mostrado."
        acao={{ href: montarHref(estado), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
      />
    );
  }

  return (
    <>
      <KpiStrip cells={celulasDoResumo(ranking, estado)} />

      {/* As colunas só se explicavam no title, que o toque não abre (UX_SYSTEM §6, bloco 4). */}
      <div className="sb-central-bloco">
        <Glossario titulo="O que significa cada coluna" termos={TERMOS_DO_RANKING} />
      </div>

      <Resumo ranking={ranking} estado={estado} />

      <Lista ranking={ranking} estado={estado} margemMinima={(await leituraLimites).margemMinima} />

      <ComoCalcula ranking={ranking} />
    </>
  );
}

/** As mesmas regras do `get_ranking_produtos` e de /faturamento. */
const TERMOS_DO_RANKING = [
  {
    termo: "Pedidos cobertos",
    definicao:
      "Os pedidos com resultado conhecido: frete observado, custo do produto conhecido e um só produto no pedido. Pedido com vários produtos não entra no resultado de nenhum deles, porque o frete é do pacote.",
  },
  { termo: "Unid.", definicao: "Unidades vendidas no período, em todos os pedidos válidos." },
  {
    termo: "Receita",
    definicao:
      "Receita bruta do período, em todos os pedidos válidos. Embaixo, a variação contra o período anterior, só com 5 pedidos ou mais nos dois.",
  },
  { termo: "Comissão", definicao: "A comissão do Mercado Livre por unidade × as unidades, em todos os pedidos." },
  {
    termo: "Frete",
    definicao: "O frete pago pelo vendedor nos pedidos cobertos. Embaixo, quanto ele pesa na receita desses mesmos pedidos.",
  },
  {
    termo: "Custo",
    definicao:
      "O custo do produto na data da venda, nos pedidos cobertos. Com *, algum pedido usou o custo atual, por não haver custo cadastrado antes da venda.",
  },
  {
    termo: "Resultado",
    definicao:
      "Receita − comissão − frete − custo, nos pedidos cobertos. Não é lucro líquido: custos fixos, devoluções e Ads ficam fora.",
  },
  {
    termo: "Margem",
    definicao:
      "Resultado ÷ receita dos pedidos cobertos. O selo marca perigo abaixo de zero e atenção abaixo da margem mínima dos limites. Embaixo, a variação em pontos percentuais (p.p.) contra o anterior, só com 5 pedidos cobertos nos dois.",
  },
  {
    termo: "Após imposto",
    definicao:
      "Aparece quando há alíquota cadastrada em Metas e imposto: o resultado menos o imposto pela alíquota vigente no dia de cada pedido.",
  },
  {
    termo: "Metade do resultado",
    definicao:
      "Quantos produtos, começando pelos de maior resultado, somam metade do resultado de todos. Quanto menor o número, mais o resultado depende de poucos produtos.",
  },
] as const;

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
  { id: "taxas", rotulo: "Comissão", titulo: "comissão do Mercado Livre por unidade × unidades, todos os pedidos" },
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
          <EstadoDaTela tipo="vazio" titulo={vazio(ranking.ordem, estado.pagina)} />
        ) : (
          <>
          <p className="sb-tabela-dica" aria-hidden="true">Deslize a tabela para o lado para ver todas as colunas.</p>
          <div className="sb-central-tabela">
            <table className="sb-table sb-rank-tabela">
              <thead>
                <tr>
                  <th className="sb-num">#</th>
                  <th className="sb-col-fixa">Produto</th>
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
          </>
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
      <td className="sb-col-fixa">
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
        {p.frete_sobre_receita !== null && <span className="sb-central-motivo">{formatPercent(p.frete_sobre_receita)} da receita coberta</span>}
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
