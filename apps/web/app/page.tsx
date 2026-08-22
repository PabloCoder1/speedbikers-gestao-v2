import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Painel de progresso da construção.
 *
 * Não é a Home do produto — essa é assunto da Fase 5A, quando houver dado real
 * para mostrar. Esta página existe para tornar o avanço visível sem precisar
 * ler commit.
 *
 * Regra ao editar: só marcar como pronto o que está **verificado**. Uma página
 * de status que mente é pior que página nenhuma.
 */

interface Item {
  readonly label: string;
  readonly detail: string;
  readonly state: "pronto" | "andamento" | "pendente";
}

interface Phase {
  readonly title: string;
  readonly caption: string;
  readonly items: readonly Item[];
}

const PHASES: readonly Phase[] = [
  {
    title: "Fase 1 — Fundação técnica",
    caption: "Concluída. Um job atravessa a malha inteira até o Postgres.",
    items: [
      { label: "Monorepo", detail: "pnpm + Turborepo", state: "pronto" },
      { label: "Contratos", detail: "@sb/contracts", state: "pronto" },
      { label: "Domínio", detail: "@sb/domain — lógica pura", state: "pronto" },
      { label: "Observabilidade", detail: "@sb/observability", state: "pronto" },
      { label: "Banco", detail: "@sb/db + Supabase V3 Dev", state: "pronto" },
      { label: "API", detail: "apps/api no Cloud Run", state: "pronto" },
      { label: "Worker", detail: "apps/worker no Cloud Run", state: "pronto" },
      { label: "Web", detail: "apps/web na Vercel", state: "pronto" },
      { label: "Filas", detail: "Cloud Tasks + Scheduler", state: "pronto" },
      { label: "CI", detail: "GitHub Actions — 4 jobs", state: "pronto" },
    ],
  },
  {
    title: "Fase 2 — Core de dados",
    caption: "14 tabelas, todas com RLS, GRANT mínimo e teste negativo.",
    items: [
      { label: "Identidade", detail: "organizações, perfis, papéis", state: "pronto" },
      { label: "Contas ML", detail: "credenciais cifradas + OAuth", state: "pronto" },
      { label: "Catálogo", detail: "SKUs e composição de kit", state: "pronto" },
      { label: "Vinculações", detail: "SKU ↔ anúncio do Mercado Livre", state: "pronto" },
      { label: "Parsers", detail: "normalização do UpSeller", state: "pronto" },
      { label: "Login", detail: "sessão, papéis e proteção de rota", state: "pronto" },
      { label: "Conferência", detail: "ver o que o arquivo produziu antes de aplicar", state: "pronto" },
      { label: "Importador", detail: "upload, conferência e aplicação da planilha", state: "pronto" },
      { label: "Central de Vinculações", detail: "candidato, match exato e confirmação humana", state: "pronto" },
      { label: "ETL da V2", detail: "descartado por evidência medida (D-040)", state: "pronto" },
    ],
  },
  {
    title: "Fase 3 — Mercado Livre e histórico",
    caption: "Concluída. Pedidos frescos em minutos, histórico com domain_events.",
    items: [
      { label: "Cliente ML", detail: "OAuth, backoff, paginação — @sb/mercado-livre", state: "pronto" },
      { label: "Webhook", detail: "ACK rápido, allowlist de IP", state: "pronto" },
      { label: "Conexão OAuth", detail: "connect + callback, tokens cifrados", state: "pronto" },
      { label: "Reconciliação", detail: "por janela, a cada hora", state: "pronto" },
      { label: "Backfill", detail: "12 meses de histórico, retomável", state: "pronto" },
      { label: "Pedidos", detail: "orders/order_items com pack_id", state: "pronto" },
      { label: "Motor de diff", detail: "domain_events, order.cancelled", state: "pronto" },
      { label: "Saúde da Sincronização", detail: "frescor por conta + eventos", state: "pronto" },
    ],
  },
  {
    title: "Fase 5A — Dashboards de venda",
    caption: "Concluída. A tela âncora — antes desta fase não havia dado de negócio nenhum.",
    items: [
      { label: "Métricas", detail: "catálogo oficial, docs/METRICS.md", state: "pronto" },
      { label: "Fato + rollups", detail: "diário, por conta/SKU/anúncio", state: "pronto" },
      { label: "Recálculo", detail: "incremental por chave suja + rebuild", state: "pronto" },
      { label: "Dashboard /vendas", detail: "Geral e por Conta, período, comparação", state: "pronto" },
    ],
  },
  {
    title: "Fase 4 — Estoque e compras",
    caption: "Em andamento. Aqui o estoque vira ferramenta de trabalho.",
    items: [
      { label: "Ledger", detail: "stock_movements, idempotente e auditável", state: "pronto" },
      { label: "Dedução por venda", detail: "aplicada na persistência do pedido", state: "pronto" },
      { label: "Reversão", detail: "por cancelamento (devolução fica para depois)", state: "pronto" },
      { label: "Full por conta", detail: "captura + eventos por diff (sem variação)", state: "pronto" },
      { label: "NF-e / XML", detail: "aguardando arquivo real para o parser", state: "pendente" },
      { label: "Reservado / trânsito", detail: "dois dos quatro estados de estoque", state: "pendente" },
      { label: "Reconciliação ERP", detail: "alinhamento com o snapshot do UpSeller", state: "pendente" },
      { label: "Pedidos de compra", detail: "ciclo, histórico, nacional × importado", state: "pendente" },
    ],
  },
  {
    title: "Adiante",
    caption: "Nada começado. A ordem está em docs/ROADMAP.md.",
    items: [
      { label: "Fase 5B", detail: "cobertura, curva ABC, visitas, Ads", state: "pendente" },
      { label: "Fase 6", detail: "diagnóstico e ações", state: "pendente" },
      { label: "Fase 7", detail: "notificações e Copiloto", state: "pendente" },
    ],
  },
];

const TONE: Readonly<Record<Item["state"], { color: string; label: string }>> = {
  pronto: { color: "var(--sb-secondary)", label: "PRONTO" },
  andamento: { color: "var(--sb-accent-ink)", label: "EM ANDAMENTO" },
  pendente: { color: "var(--sb-muted-ink)", label: "PENDENTE" },
};

function Row({ item }: { item: Item }): ReactNode {
  const tone = TONE[item.state];

  return (
    <li
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--sb-space-3)",
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        borderLeft: `3px solid ${tone.color}`,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontWeight: 600, minWidth: "8rem" }}>{item.label}</span>
      <span style={{ color: "var(--sb-text-soft)", flex: 1, minWidth: "12rem" }}>
        {item.detail}
      </span>
      <span
        style={{
          fontSize: "0.6875rem",
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: tone.color,
          whiteSpace: "nowrap",
        }}
      >
        {tone.label}
      </span>
    </li>
  );
}

export default function Page(): ReactNode {
  const pronto = PHASES.flatMap((p) => p.items).filter((i) => i.state === "pronto").length;
  const total = PHASES.flatMap((p) => p.items).length;

  return (
    <main
      style={{
        maxWidth: "52rem",
        margin: "0 auto",
        padding: "var(--sb-space-5) var(--sb-space-3)",
      }}
    >
      <p
        style={{
          margin: 0,
          color: "var(--sb-text-soft)",
          fontSize: "0.8125rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Speed Bikers Gestão
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0 0", fontSize: "2rem", lineHeight: 1.2 }}>
        V3 — construção
      </h1>

      <p style={{ color: "var(--sb-text-soft)", marginTop: "var(--sb-space-2)" }}>
        {pronto} de {total} entregas concluídas. Só aparece como pronto o que foi verificado
        rodando — nesta página, status é medição, não intenção.
      </p>

      {PHASES.map((phase) => (
        <section key={phase.title} style={{ marginTop: "var(--sb-space-5)" }}>
          <h2 style={{ fontSize: "1.0625rem", margin: 0 }}>{phase.title}</h2>
          <p
            style={{
              color: "var(--sb-text-soft)",
              fontSize: "0.9375rem",
              margin: "var(--sb-space-1) 0 var(--sb-space-3)",
            }}
          >
            {phase.caption}
          </p>

          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "var(--sb-space-2)" }}>
            {phase.items.map((item) => (
              <Row key={item.label} item={item} />
            ))}
          </ul>
        </section>
      ))}

      <p
        style={{
          marginTop: "var(--sb-space-5)",
          paddingTop: "var(--sb-space-3)",
          borderTop: "1px solid var(--sb-border)",
          color: "var(--sb-text-soft)",
          fontSize: "0.875rem",
        }}
      >
        O Dashboard de Vendas (/vendas) já é a tela âncora com dado real (D-033). A Home
        orientada a “o que precisa da minha atenção hoje?” — cruzando venda, estoque e evento —
        continua para uma fase futura, quando estoque e diagnóstico existirem também.
      </p>

      <p style={{ fontSize: "0.875rem" }}>
        <Link href="/vendas">Entrar no sistema →</Link>
      </p>
    </main>
  );
}
