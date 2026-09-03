import Link from "next/link";
import { previousBusinessDateRange, shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { Shell } from "../components/shell";
import { formatCount, formatCurrency } from "../lib/format";
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
 * ── D4 da frente visual ──────────────────────────────────────────────────
 *
 * O brief pede cards PRIORIZADOS, com severidade, explicação e ação
 * (`speed-bikers-design.md`, seção 10). A severidade aqui **não é inventada**:
 * `actions.severity` é coluna real, restrita por CHECK a `baixa|media|alta`, e
 * ruptura vem de `get_stock_coverage_summary`, a mesma função que `/cobertura`
 * usa no cabeçalho dela.
 *
 * **Ruptura não chega por `actions`, e isso é um achado, não um detalhe.** O
 * motor de ações emite três tipos — `venda_anomala`, `reclamacoes_recorrentes`
 * e `republicacao` — e nenhum deles é ruptura. O primeiro exemplo de CRÍTICO do
 * brief ("7 SKUs Curva A em ruptura") não existiria se a Home só lesse o motor
 * de atenção. Enquanto a lacuna não fechar, a Home lê a cobertura direto.
 *
 * **Nada é escondido quando é zero.** A tentação era mostrar só o que tem
 * número; um card zerado, porém, é a diferença entre "medi e está limpo" e
 * "não medi". Zero mantém o card e perde a cor de severidade — a prioridade
 * sai, o fato fica. Falha de leitura NUNCA vira zero (D-067).
 *
 * **Sem porcentagem de variação**, pela mesma razão que `/vendas`: `docs/
 * METRICS.md` 5.4 deixou `variacao_percentual_periodo` pendente de definição, e
 * D-023 proíbe exibir número sintetizado sem `metric_definitions` por trás. Os
 * dois valores aparecem lado a lado e a leitura fica com quem olha.
 *
 * **O que o brief pede e esta tela NÃO mostra**, por decisão registrada em
 * `docs/DESIGN_IMPLEMENTATION.md`: "faturamento líquido" (nome vetado, METRICS
 * 5C.1), cancelamento e SKUs distintos (vêm de outras funções, e são o assunto
 * de `/vendas`), e o dia em andamento — `/vendas` já tem o bloco "Hoje" com o
 * aviso de dia parcial, e uma segunda tela repetindo o mesmo número com o mesmo
 * aviso seria dois donos do mesmo dado.
 */

const JANELA_DIAS = 30;

type Severidade = "critico" | "importante" | "acompanhar";

const TOM: Record<Severidade, { rotulo: string; faixa: string; pilulaFundo: string; pilulaTinta: string }> = {
  critico: {
    rotulo: "Crítico",
    faixa: "var(--sb-danger)",
    pilulaFundo: "var(--sb-danger-soft)",
    pilulaTinta: "var(--sb-danger-ink)",
  },
  importante: {
    rotulo: "Importante",
    faixa: "var(--sb-accent-ink)",
    pilulaFundo: "var(--sb-accent-soft)",
    pilulaTinta: "var(--sb-accent-ink)",
  },
  acompanhar: {
    rotulo: "Acompanhar",
    faixa: "var(--sb-secondary)",
    pilulaFundo: "var(--sb-bg-soft)",
    pilulaTinta: "var(--sb-secondary)",
  },
};

const ORDEM: Record<Severidade, number> = { critico: 0, importante: 1, acompanhar: 2 };

interface Card {
  readonly label: string;
  readonly caption: string;
  readonly href: string;
  readonly cta: string;
  readonly count: number | null;
  readonly severidade: Severidade;
  /** Falha de leitura NUNCA vira zero (D-067) — some o número e aparece o aviso. */
  readonly failed: boolean;
}

function AttentionCard({ card }: { card: Card }): ReactNode {
  const vazio = !card.failed && (card.count ?? 0) === 0;
  const tom = TOM[card.severidade];

  return (
    <Link
      href={card.href}
      style={{
        display: "grid",
        gap: "var(--sb-space-2)",
        padding: "var(--sb-space-3)",
        borderRadius: "var(--sb-radius)",
        border: "1px solid var(--sb-border)",
        // A faixa de 4px na cor do estado é o gesto do `.attention-card` do
        // Figma. Medida contra o cartão branco: 4,92:1 (crítico), 4,91:1
        // (importante), 9,68:1 (acompanhar) — a WCAG 1.4.11 pede 3:1 de objeto
        // gráfico que carrega significado.
        borderLeft: `4px solid ${card.failed || vazio ? "var(--sb-muted-ink)" : tom.faixa}`,
        background: "var(--sb-surface)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
        {/* Severidade em TEXTO, nunca só em cor: cerca de 8% dos homens não
            distinguem vermelho de verde — a mesma doutrina de `StatusPill`. */}
        <span
          style={{
            display: "inline-block",
            borderRadius: "999px",
            padding: "0.125rem 0.5rem",
            fontSize: "0.6875rem",
            fontWeight: 600,
            background: card.failed || vazio ? "var(--sb-muted)" : tom.pilulaFundo,
            color: card.failed || vazio ? "var(--sb-text)" : tom.pilulaTinta,
          }}
        >
          {/* Um card que falhou NÃO anuncia severidade: dizer "Crítico" sobre
              um número que não foi lido é afirmar o que não se sabe. */}
          {card.failed ? "Não medido" : vazio ? "Limpo" : tom.rotulo}
        </span>

        <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{card.label}</span>
      </div>

      <div style={{ fontSize: "1.75rem", fontWeight: 600, lineHeight: 1.1 }}>
        {card.failed ? "—" : formatCount(card.count)}
      </div>

      <div style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        {card.failed ? "Não foi possível carregar" : card.caption}
      </div>

      <div style={{ fontSize: "0.8125rem", color: "var(--sb-secondary)" }}>{card.cta} →</div>
    </Link>
  );
}

function Kpi({
  label,
  atual,
  anterior,
  nunca,
}: {
  label: string;
  atual: string;
  anterior: string;
  nunca: boolean;
}): ReactNode {
  return (
    <div
      style={{
        padding: "var(--sb-space-3)",
        borderRadius: "var(--sb-radius)",
        border: "1px solid var(--sb-border)",
        background: "var(--sb-surface)",
        display: "grid",
        gap: "0.25rem",
      }}
    >
      <div style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600, lineHeight: 1.1 }}>{nunca ? "—" : atual}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
        {nunca ? "nunca calculado para esta janela" : `período anterior: ${anterior}`}
      </div>
    </div>
  );
}

interface SalesSummaryRow {
  units_sold: number | null;
  gross_revenue: number | null;
  orders_count: number | null;
  average_ticket: number | null;
  last_computed_at: string | null;
}

function primeira(data: unknown): SalesSummaryRow | null {
  return Array.isArray(data) && data.length > 0 ? (data[0] as SalesSummaryRow) : null;
}

export default async function HomePage(): Promise<ReactNode> {
  const supabase = await createClient();

  const hoje = toSalesMetricDate(new Date());
  const janela = { from: shiftBusinessDate(hoje, -(JANELA_DIAS - 1)), to: hoje };
  const anterior = previousBusinessDateRange(janela.from, janela.to);

  // Consultas independentes em paralelo, nunca em cascata
  // (`docs/ARCHITECTURE.md` secao 21, regra 4).
  //
  // O bloco já era paralelo — mas ele inteiro esperava a leitura da
  // organização, e nenhuma das quatro a usa: quem restringe por organização é
  // a RLS. A regra estava obedecida por dentro e quebrada por fora, e o
  // comentário acima não bastou para ver isso (D-197). O `membership` entrou
  // no mesmo `Promise.all`.
  //
  // `get_sales_summary` também não recebe organização — a RLS resolve — então
  // as duas janelas entram aqui e não custam ida nova (D-185: o custo é o
  // round trip, não o SQL).
  const [membership, acoesAltas, acoesOutras, openCases, mediations, unread, vendas, vendasAntes] =
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
        // `notification_id`, e NAO `id`: esta tabela nao tem coluna `id` — a
        // chave é composta `(notification_id, user_id)`. Pedir `id` fazia o
        // PostgREST recusar, e a Home mostrava "Não foi possível carregar"
        // neste card desde que ele existe. O contador nunca funcionou; ninguém
        // viu porque D-067 manda falha aparecer como "—", e um "—" parece
        // discrição, não defeito. `components/shell.tsx` escapou por usar `*`.
        .select("notification_id", { count: "exact", head: true })
        .is("read_at", null),
      supabase.rpc("get_sales_summary", { p_date_from: janela.from, p_date_to: janela.to }),
      supabase.rpc("get_sales_summary", { p_date_from: anterior.from, p_date_to: anterior.to }),
    ]);

  const organizationId = membership.organizationId;

  if (membership.error !== null || organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>
          Visão Geral
        </h1>
        <p style={{ color: "var(--sb-text-soft)" }}>
          Sua conta não está associada a nenhuma organização.
        </p>
      </Shell>
    );
  }

  // fila-justificada: `get_stock_coverage_summary` exige `p_organization_id`, e
  // a organização só se conhece depois da leitura acima. É UMA ida a mais, e
  // ela compra o card que o brief põe como primeiro exemplo de crítico —
  // ruptura, que o motor de ações não emite. As sete leituras acima continuam
  // numa ida só; esta é a segunda e última.
  const coverage = await supabase.rpc("get_stock_coverage_summary", {
    p_organization_id: organizationId,
    p_date_from: janela.from,
    p_date_to: janela.to,
  });

  const coverageRow = primeira(coverage.data) as { em_ruptura: number | null } | null;

  const cards: readonly Card[] = [
    {
      label: "SKUs em ruptura",
      caption: "vendem e estão sem saldo para vender",
      href: "/cobertura",
      cta: "Ver cobertura",
      count: coverageRow?.em_ruptura ?? null,
      severidade: "critico",
      failed: coverage.error !== null,
    },
    {
      label: "Em mediação",
      caption: "com representante do Mercado Livre; subconjunto dos atendimentos abertos",
      href: "/atendimento?canal=CLAIM",
      cta: "Ver mediações",
      count: mediations.count,
      severidade: "critico",
      failed: mediations.error !== null,
    },
    {
      label: "Ações de impacto alto",
      caption: "severidade alta, ordenadas por impacto financeiro estimado",
      href: "/acoes",
      cta: "Ver ações",
      count: acoesAltas.count,
      severidade: "critico",
      failed: acoesAltas.error !== null,
    },
    {
      label: "Outras ações abertas",
      caption: "severidade média e baixa",
      href: "/acoes",
      cta: "Ver ações",
      count: acoesOutras.count,
      severidade: "importante",
      failed: acoesOutras.error !== null,
    },
    {
      label: "Atendimentos abertos",
      caption: "perguntas, mensagens e reclamações, incluindo as em mediação",
      href: "/atendimento",
      cta: "Ver caixa de entrada",
      count: openCases.count,
      severidade: "importante",
      failed: openCases.error !== null,
    },
    {
      label: "Notificações não lidas",
      caption: "eventos que ainda não foram vistos",
      href: "/notificacoes",
      cta: "Ver notificações",
      count: unread.count,
      severidade: "acompanhar",
      failed: unread.error !== null,
    },
  ];

  // A ordem é a pergunta da tela, então ela tem três degraus e não dois.
  // Primeiro o que falhou: "não sei" é mais urgente que qualquer número.
  // Depois o que TEM número, por severidade. Só então o que está limpo — a
  // primeira versão punha um crítico zerado à frente de um importante com 1, e
  // a tela renderizada mostrou que isso lê errado: zero não pede atenção,
  // ainda que a categoria dele seja grave.
  const grau = (c: Card): number => (c.failed ? 0 : (c.count ?? 0) > 0 ? 1 : 2);

  const ordenados = [...cards].sort((a, b) => {
    if (grau(a) !== grau(b)) return grau(a) - grau(b);
    if (ORDEM[a.severidade] !== ORDEM[b.severidade]) return ORDEM[a.severidade] - ORDEM[b.severidade];
    return (b.count ?? 0) - (a.count ?? 0);
  });

  const tudoLimpo = cards.every((card) => !card.failed && (card.count ?? 0) === 0);

  const atual = primeira(vendas.data);
  const antes = primeira(vendasAntes.data);
  // "Nunca calculado" e "calculado e zero" são estados diferentes — o mesmo
  // contrato que `/vendas` respeita. `last_computed_at` nulo é o primeiro.
  const semJanela = vendas.error !== null || atual?.last_computed_at == null;

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>
        O que precisa da sua atenção hoje?
      </h1>

      <p
        style={{
          margin: "0 0 var(--sb-space-4)",
          color: "var(--sb-text-soft)",
          fontSize: "0.9375rem",
        }}
      >
        Cada número abaixo é lido do mesmo dado que a tela correspondente
        mostra. Zero não some da lista: medido e limpo é diferente de não
        medido.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "var(--sb-space-3)",
        }}
      >
        {ordenados.map((card) => (
          <AttentionCard card={card} key={card.label} />
        ))}
      </div>

      {tudoLimpo ? (
        <p
          style={{
            marginTop: "var(--sb-space-4)",
            color: "var(--sb-text-soft)",
            fontSize: "0.9375rem",
          }}
        >
          Nada aberto no momento. Um dia sem pendência é um resultado, não um
          estado vazio.
        </p>
      ) : null}

      <h2 style={{ margin: "var(--sb-space-5) 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>
        Últimos {String(JANELA_DIAS)} dias
      </h2>

      <p
        style={{
          margin: "0 0 var(--sb-space-3)",
          color: "var(--sb-text-soft)",
          fontSize: "0.8125rem",
        }}
      >
        {janela.from} a {janela.to}, comparado com {anterior.from} a {anterior.to}. Os dois valores
        aparecem lado a lado, sem porcentagem: a variação percentual ainda não tem definição em
        `metric_definitions`, e número sintetizado sem definição é proibido (D-023).
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "var(--sb-space-3)",
        }}
      >
        <Kpi
          label="Faturamento bruto"
          atual={formatCurrency(atual?.gross_revenue ?? null)}
          anterior={formatCurrency(antes?.gross_revenue ?? null)}
          nunca={semJanela}
        />
        <Kpi
          label="Unidades vendidas"
          atual={formatCount(atual?.units_sold ?? null)}
          anterior={formatCount(antes?.units_sold ?? null)}
          nunca={semJanela}
        />
        <Kpi
          label="Pedidos"
          atual={formatCount(atual?.orders_count ?? null)}
          anterior={formatCount(antes?.orders_count ?? null)}
          nunca={semJanela}
        />
        <Kpi
          label="Ticket médio"
          atual={formatCurrency(atual?.average_ticket ?? null)}
          anterior={formatCurrency(antes?.average_ticket ?? null)}
          nunca={semJanela}
        />
      </div>

      <p style={{ marginTop: "var(--sb-space-4)", fontSize: "0.9375rem" }}>
        <Link href="/vendas" style={{ color: "var(--sb-secondary)" }}>
          Ver o Dashboard de Vendas →
        </Link>
      </p>
    </Shell>
  );
}
