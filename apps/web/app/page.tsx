import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../components/shell";
import { formatCount } from "../lib/format";
import { createClient } from "../lib/supabase/server";

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
 * mentia em sete pontos: dava `PENDENTE` para NF-e/XML, Reservado/trânsito,
 * Reconciliação ERP e Pedidos de compra (todos entregues na Fase 4) e "Nada
 * começado" para as Fases 5B, 6 e 7 (todas concluídas). Ele próprio
 * carregava a regra que passou a violar: "uma página de status que mente é
 * pior que página nenhuma".
 *
 * **A escolha estrutural é essa**: todo número aqui vem de CONSULTA ao mesmo
 * dado que as telas reais leem. Não existe lista para manter, então não
 * existe como divergir de novo.
 *
 * Primeira fatia deliberada: quatro contadores sobre tabelas que já existem
 * e já estão provadas. Ruptura, SKU de alta importância sem Full, alterações
 * de anúncio e decisões aguardando medição entram quando cada um tiver a
 * consulta agregada correspondente — `docs/PRODUCT_REQUIREMENTS.md` já manda
 * criar bloco só quando houver dado real para sustentá-lo.
 */

interface Card {
  readonly label: string;
  readonly caption: string;
  readonly href: string;
  readonly count: number | null;
  /** Falha de leitura NUNCA vira zero (D-067) — some o número e aparece o aviso. */
  readonly failed: boolean;
  readonly emphasis?: boolean;
}

function AttentionCard({ card }: { card: Card }): ReactNode {
  return (
    <Link
      href={card.href}
      style={{
        display: "block",
        padding: "var(--sb-space-4)",
        borderRadius: "var(--sb-radius)",
        border: "1px solid var(--sb-border)",
        borderLeft: `3px solid ${card.emphasis === true ? "var(--sb-danger)" : "var(--sb-primary)"}`,
        background: "var(--sb-surface)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{card.label}</div>

      <div style={{ fontSize: "1.75rem", fontWeight: 600, margin: "0.25rem 0" }}>
        {card.failed ? "—" : formatCount(card.count)}
      </div>

      <div style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        {card.failed ? "Não foi possível carregar" : card.caption}
      </div>
    </Link>
  );
}

export default async function HomePage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (membership.error !== null || organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Visão Geral</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // Consultas independentes em paralelo, nunca em cascata
  // (`docs/ARCHITECTURE.md` secao 21, regra 4).
  const [openActions, openCases, mediations, unread] = await Promise.all([
    supabase
      .from("actions")
      .select("id", { count: "exact", head: true })
      .in("status", ["novo", "em_andamento"]),
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
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
  ]);

  const cards: readonly Card[] = [
    {
      label: "Ações abertas",
      caption: "problemas e oportunidades por impacto",
      href: "/acoes",
      count: openActions.count,
      failed: openActions.error !== null,
    },
    {
      label: "Atendimentos abertos",
      caption: "perguntas, mensagens e reclamações",
      href: "/atendimento",
      count: openCases.count,
      failed: openCases.error !== null,
    },
    {
      label: "Em mediação",
      caption: "com representante do Mercado Livre",
      href: "/atendimento?canal=CLAIM",
      count: mediations.count,
      failed: mediations.error !== null,
      emphasis: (mediations.count ?? 0) > 0,
    },
    {
      label: "Notificações não lidas",
      caption: "eventos que ainda não foram vistos",
      href: "/notificacoes",
      count: unread.count,
      failed: unread.error !== null,
    },
  ];

  const allQuiet = cards.every((card) => !card.failed && (card.count ?? 0) === 0);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>
        O que precisa da sua atenção hoje?
      </h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Cada número abaixo é lido do mesmo dado que a tela correspondente mostra.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: "var(--sb-space-3)",
        }}
      >
        {cards.map((card) => (
          <AttentionCard card={card} key={card.href} />
        ))}
      </div>

      {allQuiet ? (
        <p style={{ marginTop: "var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
          Nada aberto no momento. Um dia sem pendência é um resultado, não um estado vazio.
        </p>
      ) : null}

      <p style={{ marginTop: "var(--sb-space-5)", fontSize: "0.9375rem" }}>
        <Link href="/vendas" style={{ color: "var(--sb-secondary)" }}>
          Ver o Dashboard de Vendas →
        </Link>
      </p>
    </Shell>
  );
}
