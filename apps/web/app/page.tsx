import Link from "next/link";
import { previousBusinessDateRange, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../components/kpi-strip";
import { PageTitle } from "../components/page-title";
import { Panel } from "../components/panel";
import { SalesChart } from "./vendas/sales-chart";
import { Shell } from "../components/shell";
import { TOM, type Tom } from "../components/tone";
import { DEFAULT_SALES_METRIC } from "../lib/sales-metric";
import { eventTypeLabel, severityLabel } from "../lib/labels";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../lib/format";
import { createClient } from "../lib/supabase/server";
import { currentMembership } from "../lib/membership";

export const metadata = { title: "Visão Geral — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Visão Geral — "o que precisa da minha atenção hoje?"
 * (`docs/PRODUCT_REQUIREMENTS.md`, "Home orientada à atenção").
 *
 * **Substitui o painel de progresso da construção**, removido em 2026-08-27
 * (D-105). Aquele painel era uma lista escrita à mão e, na data da remoção,
 * mentia em sete pontos. Ele próprio carregava a regra que passou a violar:
 * "uma página de status que mente é pior que página nenhuma".
 *
 * **A escolha estrutural é essa**: todo número aqui vem de CONSULTA ao mesmo
 * dado que as telas reais leem. Não existe lista para manter, então não
 * existe como divergir de novo.
 *
 * ── Composição: refeita a partir do frame `Home` do Figma ────────────────
 *
 * D4 pôs a severidade certa (`actions.severity` é coluna real, com CHECK em
 * `baixa|media|alta`) mas manteve a composição herdada: uma grade solta de
 * cartões. O frame é outro, e é este:
 *
 *   cabeçalho compacto (sobrancelha com a data, saudação, subtítulo)
 *   → painel "Atenção necessária" com a grade de cartões dentro
 *   → rótulo de seção "Indicadores gerais"
 *   → faixa de indicadores
 *   → grade inferior de duas colunas: gráfico largo + atividade recente
 *
 * **O que o frame pede e não existia:** o gráfico de faturamento diário e a
 * lista de atividade recente. Os dois são dado REAL — a mesma
 * `get_sales_daily_series` de `/vendas` e as mesmas `notifications` de
 * `/notificacoes`, com os mesmos rótulos canônicos. Nada foi inventado.
 *
 * **Ruptura não chega por `actions`, e isso é um achado, não um detalhe.** O
 * motor de ações emite três tipos — `venda_anomala`, `reclamacoes_recorrentes`
 * e `republicacao` — e nenhum deles é ruptura. O primeiro exemplo de crítico do
 * brief ("7 SKUs Curva A em ruptura") não existiria se a Home só lesse o motor
 * de atenção. Enquanto a lacuna não fechar, a Home lê a cobertura direto.
 *
 * **Nada é escondido quando é zero.** Um card zerado é a diferença entre "medi
 * e está limpo" e "não medi". Zero mantém o card e perde a cor de severidade;
 * o contador do cabeçalho conta só o que pede atenção. Falha de leitura NUNCA
 * vira zero (D-067).
 *
 * **Sem porcentagem de variação**, pela mesma razão que `/vendas`: METRICS 5.4
 * deixou `variacao_percentual_periodo` pendente, e D-023 proíbe número
 * sintetizado sem `metric_definitions`.
 */

const JANELA_DIAS = 30;
const SERIE_DIAS = 14;
const ATIVIDADE_LIMITE = 5;

type Severidade = "critico" | "importante" | "acompanhar";

/*
 * Rótulo, cor da borda e TOM do selo por severidade. O selo lê `tone.ts`, o
 * dono único dos cinco pares do Figma — este arquivo carregava o quarto mapa
 * de tom do app (a auditoria de fidelidade contou cinco).
 */
const SEVERIDADE: Record<Severidade, { rotulo: string; cor: string; tom: Tom }> = {
  critico: { rotulo: "Crítico", cor: "var(--sb-danger)", tom: "perigo" },
  importante: { rotulo: "Importante", cor: "var(--sb-accent-ink)", tom: "atencao" },
  acompanhar: { rotulo: "Acompanhar", cor: "var(--sb-secondary)", tom: "info" },
};

const ORDEM: Record<Severidade, number> = { critico: 0, importante: 1, acompanhar: 2 };

/** Cor do ponto na lista de atividade, pela severidade do evento de domínio. */
const COR_SEVERIDADE: Record<string, string> = {
  critico: "var(--sb-danger)",
  importante: "var(--sb-accent-ink)",
  informativo: "var(--sb-secondary)",
};

interface Card {
  readonly label: string;
  readonly caption: string;
  readonly href: string;
  readonly cta: string;
  /**
   * A linha de IMPACTO do frame ("R$ 18.720 em vendas em risco", "3 casos
   * próximos do prazo"): o número lido dentro de uma frase de negócio, no tom.
   * Recebe a contagem e devolve a frase — nada é estimado além do que se mediu.
   */
  readonly impacto: (n: number) => string;
  readonly count: number | null;
  readonly severidade: Severidade;
  /** Falha de leitura NUNCA vira zero (D-067) — some o número e aparece o aviso. */
  readonly failed: boolean;
}

function AttentionCard({ card }: { card: Card }): ReactNode {
  const vazio = !card.failed && (card.count ?? 0) === 0;
  const neutro = card.failed || vazio;
  const sev = SEVERIDADE[card.severidade];
  const selo = neutro ? TOM.neutro : TOM[sev.tom];

  return (
    <Link
      href={card.href}
      className={
        !neutro && card.severidade === "critico" ? "sb-attention-card sb-attention-card-critico" : "sb-attention-card"
      }
      // A borda inteira leva o tom, como no frame. `--sb-tone` é lida pela
      // classe, então a regra de CSS é uma só para os três estados.
      style={{
        ["--sb-tone" as string]: neutro ? "var(--sb-border)" : sev.cor,
        ["--sb-tone-ink" as string]: neutro ? "var(--sb-text)" : selo.color,
      }}
    >
      <div className="sb-attention-card-head">
        <h3>{card.label}</h3>

        {/* Severidade em TEXTO, nunca só em cor: cerca de 8% dos homens não
            distinguem vermelho de verde — a mesma doutrina de `StatusPill`.
            E um card que falhou NÃO anuncia severidade: dizer "Crítico" sobre
            um número que não foi lido é afirmar o que não se sabe. */}
        <span className="sb-status" style={selo}>
          {card.failed ? "Não medido" : vazio ? "Limpo" : sev.rotulo}
        </span>
      </div>

      {/*
        Como no frame: uma frase de impacto em negrito no tom, e a legenda
        embaixo. O número grande solto saiu — "1" não diz nada; "1 ação de
        severidade alta aberta" diz. Falha de leitura NUNCA vira zero (D-067).
      */}
      <p className="sb-attention-impact">{card.failed ? "Leitura indisponível" : card.impacto(card.count ?? 0)}</p>

      <p>{card.failed ? "Não foi possível carregar" : card.caption}</p>

      {/* `<Button variant=primary|ghost className="w-full">` no frame — um
          botão de largura total no rodapé, primário quando é crítico. */}
      <span className="sb-attention-cta">
        <span>{card.cta}</span>
      </span>
    </Link>
  );
}

interface SalesSummaryRow {
  units_sold: number | null;
  gross_revenue: number | null;
  orders_count: number | null;
  average_ticket: number | null;
  last_computed_at: string | null;
}

interface SeriePonto {
  metric_date: string;
  gross_revenue: number;
  units_sold: number;
  orders_count: number;
  purchases_count: number | null;
}

interface AtividadeLinha {
  id: string;
  created_at: string;
  domain_events: {
    event_type: string;
    entity_type: string;
    severity: string;
    ml_accounts: { label: string } | null;
  } | null;
}

function primeira(data: unknown): SalesSummaryRow | null {
  return Array.isArray(data) && data.length > 0 ? (data[0] as SalesSummaryRow) : null;
}

/**
 * Saudação por hora de São Paulo — o fuso da operação, o mesmo que
 * `toSalesMetricDate` usa para fechar o dia. Sem `full_name` no perfil não há
 * a quem saudar, e a tela volta a abrir com a própria pergunta do produto em
 * vez de inventar um nome a partir do e-mail.
 */
function saudacao(nome: string | null, agora: Date): string {
  const hora = Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(agora),
  );
  const parte = hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";

  // Sem nome, a saudação fica só com a parte do dia — o h1 não troca de
  // assunto, e a pergunta do produto mora no subtítulo, como no frame.
  if (nome === null || nome.trim() === "") return `${parte}.`;

  return `${parte}, ${nome.trim().split(/\s+/)[0] ?? nome}.`;
}

/**
 * A sobrancelha com data do frame: "TERÇA, 18 AGO" — dia da semana curto, sem
 * "-feira", sem "DE" e sem ponto. O `Intl` produz "SEXTA-FEIRA, 04 DE SET.";
 * por isso os mapas fixos.
 */
const DIAS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"] as const;
const MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"] as const;

function sobrancelhaData(agora: Date): string {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "numeric",
  }).formatToParts(agora);
  const pegar = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? "";
  const semana = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(pegar("weekday"));
  const mes = Number(pegar("month")) - 1;

  return `${DIAS[semana] ?? ""}, ${pegar("day")} ${MESES[mes] ?? ""}`;
}

export default async function HomePage(): Promise<ReactNode> {
  const supabase = await createClient();

  const agora = new Date();
  const hoje = toSalesMetricDate(agora);
  const janela = { from: shiftBusinessDate(hoje, -(JANELA_DIAS - 1)), to: hoje };
  const anterior = previousBusinessDateRange(janela.from, janela.to);
  const serie = { from: shiftBusinessDate(hoje, -(SERIE_DIAS - 1)), to: hoje };

  // Consultas independentes em paralelo, nunca em cascata
  // (`docs/ARCHITECTURE.md` secao 21, regra 4). Nenhuma delas recebe
  // organização — quem restringe é a RLS —, então todas cabem numa ida só
  // (D-185: o custo é o round trip, não o SQL).
  // O id do usuário vem do cookie (`getSession()`), sem ida ao Auth: só para
  // filtrar a PRÓPRIA linha de `profiles`. Sem o filtro, com dois perfis
  // visíveis (D-234), `maybeSingle()` falhava e a saudação nunca tinha nome —
  // a auditoria de fidelidade viu "Boa tarde." onde o frame diz "Bom dia, João."
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user.id ?? null;

  const [membership, acoesAltas, acoesOutras, openCases, mediations, unread, vendas, vendasAntes, serieDiaria, atividade, perfil] =
    await Promise.all([
      currentMembership(supabase),
      supabase
        .from("actions")
        .select("id", { count: "exact", head: true })
        .in("status", ["novo", "em_andamento"])
        .eq("severity", "alta"),
      supabase
        .from("actions")
        .select("id", { count: "exact", head: true })
        .in("status", ["novo", "em_andamento"])
        .in("severity", ["media", "baixa"]),
      supabase
        .from("support_cases")
        .select("id", { count: "exact", head: true })
        .neq("internal_status", "RESOLVIDO"),
      supabase
        .from("support_cases")
        .select("id", { count: "exact", head: true })
        .eq("is_mediation", true)
        .neq("internal_status", "RESOLVIDO"),
      supabase
        .from("notification_recipients")
        // `notification_id`, e NÃO `id`: esta tabela não tem coluna `id` — a
        // chave é composta `(notification_id, user_id)`. Pedir `id` fazia o
        // PostgREST recusar, e este card dizia "Não foi possível carregar"
        // desde que existe (D-241).
        .select("notification_id", { count: "exact", head: true })
        .is("read_at", null),
      supabase.rpc("get_sales_summary", { p_date_from: janela.from, p_date_to: janela.to }),
      supabase.rpc("get_sales_summary", { p_date_from: anterior.from, p_date_to: anterior.to }),
      supabase.rpc("get_sales_daily_series", { p_date_from: serie.from, p_date_to: serie.to }),
      // Atividade recente — as MESMAS `notifications` de `/notificacoes`, com
      // os mesmos rótulos canônicos. A policy `notification_recipients_select_own`
      // já restringe o embed à própria linha do usuário.
      supabase
        .from("notifications")
        .select("id, created_at, domain_events(event_type, entity_type, severity, ml_accounts(label))")
        .order("created_at", { ascending: false })
        .limit(ATIVIDADE_LIMITE),
      userId === null
        ? Promise.resolve({ data: null, error: null })
        : supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    ]);

  const organizationId = membership.organizationId;

  if (membership.error !== null || organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="VISÃO GERAL" title="Visão Geral" />
        <p style={{ color: "var(--sb-text-soft)" }}>
          Sua conta não está associada a nenhuma organização.
        </p>
      </Shell>
    );
  }

  // fila-justificada: `get_stock_coverage_summary` exige `p_organization_id`, e
  // a organização só se conhece depois da leitura acima. É UMA ida a mais, e
  // ela compra o card que o brief põe como primeiro exemplo de crítico —
  // ruptura, que o motor de ações não emite.
  const [coverage, pausados] = await Promise.all([
    supabase.rpc("get_stock_coverage_summary", {
      p_organization_id: organizationId,
      p_date_from: janela.from,
      p_date_to: janela.to,
    }),
    // "Anúncios pausados" é um dos quatro cartões do frame da Home, e tem dado
    // real: a MESMA função de `/anuncios`, com o MESMO predicado do link —
    // pausado E com estoque (um pausado sem estoque não tem o que reativar).
    supabase.rpc("get_listings_dashboard", {
      p_organization_id: organizationId,
      p_date_from: janela.from,
      p_date_to: janela.to,
      p_status: "paused",
      p_stock: "in",
      p_limit: 1,
    }),
  ]);

  const coverageRow = primeira(coverage.data) as { em_ruptura: number | null } | null;
  const pausadosRow = Array.isArray(pausados.data) && pausados.data.length > 0
    ? (pausados.data[0] as { total_count: number })
    : null;

  const cards: readonly Card[] = [
    {
      label: "SKUs em ruptura",
      caption: "vendem e estão sem saldo para vender",
      href: "/cobertura",
      cta: "Ver cobertura",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "SKU vendendo sem saldo" : "SKUs vendendo sem saldo"}`,
      count: coverageRow?.em_ruptura ?? null,
      severidade: "critico",
      failed: coverage.error !== null,
    },
    {
      label: "Em mediação",
      caption: "com representante do Mercado Livre; subconjunto dos atendimentos abertos",
      href: "/atendimento?canal=CLAIM",
      cta: "Ver mediações",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "caso em disputa" : "casos em disputa"}`,
      count: mediations.count,
      severidade: "critico",
      failed: mediations.error !== null,
    },
    {
      label: "Ações de impacto alto",
      caption: "severidade alta, ordenadas por impacto financeiro estimado",
      href: "/acoes",
      cta: "Ver ações",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "ação de severidade alta aberta" : "ações de severidade alta abertas"}`,
      count: acoesAltas.count,
      severidade: "critico",
      failed: acoesAltas.error !== null,
    },
    {
      label: "Outras ações abertas",
      caption: "severidade média e baixa",
      href: "/acoes",
      cta: "Ver ações",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "ação aberta" : "ações abertas"} de menor severidade`,
      count: acoesOutras.count,
      severidade: "importante",
      failed: acoesOutras.error !== null,
    },
    {
      label: "Atendimentos abertos",
      caption: "perguntas, mensagens e reclamações, incluindo as em mediação",
      href: "/atendimento",
      cta: "Ver caixa de entrada",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "atendimento aguardando resposta" : "atendimentos aguardando resposta"}`,
      count: openCases.count,
      severidade: "importante",
      failed: openCases.error !== null,
    },
    {
      label: "Notificações não lidas",
      caption: "eventos que ainda não foram vistos",
      href: "/notificacoes",
      cta: "Ver notificações",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "evento ainda não visto" : "eventos ainda não vistos"}`,
      count: unread.count,
      severidade: "acompanhar",
      failed: unread.error !== null,
    },
    {
      label: "Anúncios pausados",
      caption: "pausados com estoque disponível — têm o que reativar",
      href: "/anuncios?estado=paused&estoque=in",
      cta: "Ver anúncios",
      impacto: (n) => `${formatCount(n)} ${n === 1 ? "anúncio pausado com estoque" : "anúncios pausados com estoque"}`,
      count: pausados.error !== null ? null : (pausadosRow?.total_count ?? 0),
      severidade: "importante",
      failed: pausados.error !== null,
    },
  ];

  // A ordem é a pergunta da tela, então ela tem três degraus e não dois.
  // Primeiro o que falhou: "não sei" é mais urgente que qualquer número.
  // Depois o que TEM número, por severidade. Só então o que está limpo — um
  // crítico zerado não pede atenção, ainda que a categoria dele seja grave.
  const grau = (c: Card): number => (c.failed ? 0 : (c.count ?? 0) > 0 ? 1 : 2);

  const ordenados = [...cards].sort((a, b) => {
    if (grau(a) !== grau(b)) return grau(a) - grau(b);
    if (ORDEM[a.severidade] !== ORDEM[b.severidade]) return ORDEM[a.severidade] - ORDEM[b.severidade];
    return (b.count ?? 0) - (a.count ?? 0);
  });

  const pedemAtencao = cards.filter((card) => grau(card) < 2).length;

  // O frame só desenha as situações DETECTADAS (`attention.map(...)`) e conta
  // "N situações detectadas". O que está medido e limpo não vira cartão — vira
  // uma linha compacta abaixo da grade, para o número continuar visível
  // (medido e limpo é diferente de não medido, D-067) sem ocupar a grade.
  const detectados = ordenados.filter((card) => grau(card) < 2);
  const limpos = ordenados.filter((card) => grau(card) === 2);

  const atual = primeira(vendas.data);
  const antes = primeira(vendasAntes.data);
  // "Nunca calculado" e "calculado e zero" são estados diferentes — o mesmo
  // contrato que `/vendas` respeita. `last_computed_at` nulo é o primeiro.
  const semJanela = vendas.error !== null || atual?.last_computed_at == null;

  const kpis: readonly KpiCellData[] = [
    {
      metricId: "receita_bruta",
      label: "Faturamento bruto",
      formula: "SUM(gross_revenue) no grão dia/conta",
      value: semJanela ? "—" : formatCurrency(atual.gross_revenue),
      previous: semJanela ? null : formatCurrency(antes?.gross_revenue ?? null),
    },
    {
      metricId: "pedidos",
      label: "Pedidos",
      formula: "SUM(orders_count) no grão dia/conta",
      value: semJanela ? "—" : formatCount(atual.orders_count),
      previous: semJanela ? null : formatCount(antes?.orders_count ?? null),
    },
    {
      metricId: "unidades_vendidas",
      label: "Unidades vendidas",
      formula: "SUM(units_sold) no grão dia/conta",
      value: semJanela ? "—" : formatCount(atual.units_sold),
      previous: semJanela ? null : formatCount(antes?.units_sold ?? null),
    },
    {
      metricId: "ticket_medio",
      label: "Ticket médio",
      formula: "receita_bruta / pedidos_por_pack",
      value: semJanela ? "—" : formatCurrency(atual.average_ticket),
      previous: semJanela ? null : formatCurrency(antes?.average_ticket ?? null),
    },
  ];

  // O TypeScript já estreita `atual` para não-nulo no ramo falso de
  // `semJanela` (predicado inferido do booleano), então o `?.` seria morto
  // ali — e condição morta esconde a leitura real.
  const pontos: SeriePonto[] = serieDiaria.error === null && Array.isArray(serieDiaria.data) ? serieDiaria.data : [];

  const eventos: AtividadeLinha[] =
    atividade.error === null && Array.isArray(atividade.data) ? atividade.data : [];

  const nome = perfil.error === null ? (perfil.data?.full_name ?? null) : null;

  return (
    <Shell>
      <PageTitle
        compacto
        eyebrow={`VISÃO GERAL / ${sobrancelhaData(agora)}`}
        title={saudacao(nome, agora)}
        subtitle="O que precisa da sua atenção hoje na operação."
      />

      <section className="sb-attention" aria-label="Atenção necessária">
        <div className="sb-attention-head">
          <h2 className="sb-attention-title" style={{ color: pedemAtencao > 0 ? "var(--sb-danger)" : "var(--sb-text-soft)" }}>
            <span
              aria-hidden="true"
              className="sb-attention-dot"
              style={{ background: pedemAtencao > 0 ? "var(--sb-danger)" : "var(--sb-muted-ink)" }}
            />
            Atenção necessária
          </h2>

          <span className="sb-attention-count">
            {pedemAtencao === 0
              ? "nada aberto no momento — um dia sem pendência é um resultado"
              : `${String(pedemAtencao)} ${pedemAtencao === 1 ? "situação detectada" : "situações detectadas"}`}
          </span>
        </div>

        {detectados.length > 0 && (
          <div className="sb-attention-grid">
            {detectados.map((card) => (
              <AttentionCard card={card} key={card.label} />
            ))}
          </div>
        )}

        {limpos.length > 0 && (
          <p className="sb-attention-clean">
            <span>Medidos e limpos:</span>
            {limpos.map((card) => (
              <Link key={card.label} href={card.href} title={card.caption}>
                <b>0</b> {card.label}
              </Link>
            ))}
          </p>
        )}
      </section>

      <div className="sb-section-label">
        <span>Indicadores gerais</span>
        {/* Sem porcentagem de variação: D-023 (a justificativa mora no
            `title` de cada célula, não na tela). */}
        <span className="sb-section-note">
          últimos {JANELA_DIAS} dias ({formatBusinessDate(janela.from)} a {formatBusinessDate(janela.to)}) ·
          comparado com os {JANELA_DIAS} dias anteriores
        </span>
      </div>

      <KpiStrip ancora cells={kpis} />

      <div className="sb-lower-grid">
        <Panel
          title="Faturamento diário"
          subtitle={`últimos ${String(SERIE_DIAS)} dias · todas as contas conectadas`}
          aside={
            <Link href="/vendas" style={{ color: "var(--sb-secondary)", textDecoration: "none" }}>
              Ver o Dashboard de Vendas →
            </Link>
          }
        >
          <div style={{ padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)" }}>
            {pontos.length === 0 ? (
              <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
                Nenhum dia com métrica calculada nesta janela — o recálculo só materializa dias tocados pela
                reconciliação, e não fabrica zero.
              </p>
            ) : (
              /* Área, e não linha: é o que o frame da Home desenha. `/vendas`
                 usa a mesma função em linha, porque lá o assunto é a variação e
                 aqui é o volume. Sem comparação — a Home não compara períodos
                 no gráfico, e passar série vazia faz a legenda sumir sozinha. */
              <SalesChart
                area
                points={pontos}
                previousPoints={[]}
                metric={DEFAULT_SALES_METRIC}
                rangeFrom={serie.from}
                rangeTo={serie.to}
                previousRangeFrom={serie.from}
                previousRangeTo={serie.to}
              />
            )}
          </div>
        </Panel>

        <Panel title="Atividade recente" subtitle="Eventos que impactam sua operação">
          {atividade.error !== null ? (
            <p style={{ margin: 0, padding: "var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
              Não foi possível carregar a atividade.
            </p>
          ) : eventos.length === 0 ? (
            <p style={{ margin: 0, padding: "var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.6875rem" }}>
              Nenhum evento registrado ainda.
            </p>
          ) : (
            eventos.map((evento) => (
              <Link key={evento.id} href="/notificacoes" className="sb-feed-row">
                <span
                  aria-hidden="true"
                  className="sb-feed-dot"
                  style={{
                    ["--sb-tone" as string]:
                      COR_SEVERIDADE[evento.domain_events?.severity ?? ""] ?? "var(--sb-muted-ink)",
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{eventTypeLabel(evento.domain_events?.event_type ?? "—")}</b>
                  <small>
                    {formatDateTime(evento.created_at)}
                    {evento.domain_events !== null && ` · ${severityLabel(evento.domain_events.severity)}`}
                    {evento.domain_events?.ml_accounts != null && ` · ${evento.domain_events.ml_accounts.label}`}
                  </small>
                </span>
                <span aria-hidden="true" style={{ color: "var(--sb-text-soft)" }}>
                  ›
                </span>
              </Link>
            ))
          )}
        </Panel>
      </div>
    </Shell>
  );
}
