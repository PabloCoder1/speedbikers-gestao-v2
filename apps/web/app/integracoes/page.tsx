import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import type { PillTone } from "../../components/state-pill";
import { cardStyle, td, th } from "../../components/table-styles";
import { apiBaseUrl, fetchApiHealth } from "../../lib/api-health";
import { formatDateTime } from "../../lib/format";
import { describeIntegrations } from "../../lib/integrations";
import type { Dimension, IntegrationState } from "../../lib/integrations";
import { currentMembership } from "../../lib/membership";
import { sanitizeErrorText } from "../../lib/sanitize";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Integrações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Integrações (item C/E do ROADMAP; D-231, refeita em D-232 depois
 * da revisão adversarial).
 *
 * Uma tela que COMPÕE e APONTA. Nenhuma tabela nova, nenhuma RPC nova,
 * nenhuma permissão de nuvem nova: ela lê em paralelo o que as telas donas já
 * leem e entrega isso a `lib/integrations.ts`, que separa cada integração em
 * três dimensões — **conexão, sincronização e configuração** — porque o item
 * nomeia exatamente essa confusão como o risco: "declarar saúde só por haver
 * configuração".
 *
 * Aberta a qualquer membro, como as suas fontes (`/contas`, `/sincronizacao`,
 * `/importacoes` não têm porta ADMIN). O que é só de ADMIN — `get_system_health`
 * — refaz a autorização DENTRO da RPC e devolve zero linhas para os demais; a
 * tela traduz isso em "restrito a ADMIN" nos cards que dependem dele, em vez
 * de negar a página inteira (a primeira versão negava, e era mais restrita que
 * as próprias fontes).
 *
 * Duas regras que valem mais que qualquer selo verde aqui:
 *
 * 1. **`ok` exige atividade observada e recente.** Um `CONNECTED` gravado é
 *    flag, não atividade. Fonte sob demanda (IA, lote do UpSeller) nunca vira
 *    verde: vira "Observado", com a data.
 * 2. **Um dado, um dono (D-224).** Veredito de frescor vem de
 *    `lib/sync-health.ts`, o mesmo de `/sincronizacao` e `/saude`; reconectar
 *    conta continua em `/contas`. Esta tela não tem botão: só links.
 */

const STATE_TONE: Record<IntegrationState, PillTone> = {
  ok: { tom: "ok", label: "OK" },
  atencao: { tom: "atencao", label: "Atenção" },
  erro: { tom: "perigo", label: "Erro" },
  observado: { tom: "info", label: "Observado" },
  sem_atividade: { tom: "neutro", label: "Sem atividade" },
  nao_configurado: { tom: "neutro", label: "Não configurado" },
  nao_verificavel: { tom: "neutro", label: "Não verificável" },
};

const DIMENSION_LABEL = {
  connection: "Conexão",
  sync: "Sincronização",
  configuration: "Configuração",
} as const;

function DimensionRow({ label, dimension }: { label: string; dimension: Dimension | null }): ReactNode {
  return (
    <tr>
      <td style={{ ...td, whiteSpace: "nowrap", color: "var(--sb-text-soft)" }}>{label}</td>
      {dimension === null ? (
        // Dimensão que não se aplica (planilha não tem "conexão", webhook não
        // tem "sincronização") — dito, em vez de um estado inventado.
        <td colSpan={3} style={{ ...td, color: "var(--sb-muted-ink)" }}>
          — não se aplica
        </td>
      ) : (
        <>
          <td style={td}>
            <StatePill tone={STATE_TONE[dimension.state]} />
          </td>
          <td style={td}>{dimension.detail}</td>
          <td style={{ ...td, whiteSpace: "nowrap", color: "var(--sb-text-soft)" }}>
            {dimension.observedAt === null ? "—" : formatDateTime(dimension.observedAt)}
          </td>
        </>
      )}
    </tr>
  );
}

export default async function IntegracoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // A linha de quem está logado (filtrada por usuário — D-232), porque
  // `organization_id` é parâmetro de `get_sync_health`: dependência real.
  const membership = await currentMembership(supabase);

  if (membership.error !== null) {
    // "Não consegui ler" e "não é membro" são respostas diferentes (D-067).
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Integrações</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível ler sua organização: {sanitizeErrorText(membership.error.message)}
        </p>
      </Shell>
    );
  }

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Integrações</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // Um instante só para a página inteira (mesma razão de /saude).
  const agora = new Date();
  const inicioDoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();

  const [accounts, syncHealth, systemHealth, batches, aiRuns, aiCost, budgetEvent, apiHealth] = await Promise.all([
    supabase.from("ml_accounts").select("id, label, status, connected_at, last_error").order("label"),
    supabase.rpc("get_sync_health", { p_organization_id: organizationId }),
    supabase.rpc("get_system_health"),
    // Cancelado é estado terminal NORMAL (ato humano), não falha da integração:
    // fica fora para não esconder o último lote que valeu.
    supabase
      .from("erp_import_batches")
      .select("status, created_at, last_error")
      .neq("status", "CANCELLED")
      .order("created_at", { ascending: false })
      .limit(1),
    // MESMA janela do custo (o mês): `count: "exact"` com `limit(1)` traz a
    // contagem do conjunto e a linha mais recente numa viagem (D-185).
    supabase
      .from("ai_runs")
      .select("created_at", { count: "exact" })
      .gte("created_at", inicioDoMes)
      .order("created_at", { ascending: false })
      .limit(1),
    // Soma no banco (regra de docs/ARCHITECTURE.md secao 15), na RPC que
    // D-100 já criou para o teto mensal.
    supabase.rpc("get_ai_monthly_cost_usd", {
      p_organization_id: organizationId,
      p_from: inicioDoMes,
      p_to: agora.toISOString(),
    }),
    // Evento organizacional, legível pela web sob RLS (D-100): o teto do mês
    // foi ultrapassado?
    supabase
      .from("domain_events")
      .select("occurred_at")
      .eq("event_type", "ai.budget.exceeded")
      .gte("occurred_at", inicioDoMes)
      .order("occurred_at", { ascending: false })
      .limit(1),
    fetchApiHealth(),
  ]);

  // `get_system_health` devolve ZERO linhas para quem não é ADMIN (para ADMIN
  // sempre há ao menos a linha da migration). Zero linhas, portanto, é
  // "restrito", não "nenhum job" — e o módulo diz isso.
  const healthRows = systemHealth.error === null ? systemHealth.data : [];
  const jobs = healthRows.length === 0 ? null : healthRows.filter((row) => row.job_type !== null);
  const primeira = healthRows[0];

  const cards = describeIntegrations({
    now: agora,
    viewerIsAdmin: membership.role === "ADMIN",
    mlAccounts: accounts.error === null ? accounts.data : null,
    syncHealth: syncHealth.error === null ? syncHealth.data : null,
    jobs,
    migration:
      primeira === undefined
        ? null
        : {
            version: primeira.db_migration_version,
            name: primeira.db_migration_name,
            applied_at: primeira.db_migration_applied_at,
            count: primeira.db_migrations_count,
          },
    importBatches: batches.error === null ? batches.data : null,
    ai:
      aiRuns.error === null
        ? {
            runsThisMonth: aiRuns.count ?? 0,
            lastRunAt: aiRuns.data[0]?.created_at ?? null,
            monthCostUsd: aiCost.error === null ? aiCost.data : null,
            budgetExceededAt: budgetEvent.error === null ? (budgetEvent.data[0]?.occurred_at ?? null) : null,
          }
        : null,
    api: { configured: apiBaseUrl() !== null, health: apiHealth },
  });

  // Erro de leitura aparece, sanitizado — nunca escondido atrás de um card
  // "Não verificável" sem que a página diga que FALHOU (D-067).
  const fontes: { fonte: string; erro: { message: string } | null }[] = [
    { fonte: "contas ML", erro: accounts.error },
    { fonte: "saúde da sincronização", erro: syncHealth.error },
    { fonte: "jobs", erro: systemHealth.error },
    { fonte: "importações", erro: batches.error },
    { fonte: "uso de IA", erro: aiRuns.error },
    { fonte: "custo de IA", erro: aiCost.error },
    { fonte: "eventos de teto de IA", erro: budgetEvent.error },
  ];
  const falhas = fontes.flatMap((f) =>
    f.erro === null ? [] : [`${f.fonte}: ${sanitizeErrorText(f.erro.message) ?? "erro sem mensagem"}`],
  );

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Integrações</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Cada integração em três perguntas separadas — <strong>está conectada?</strong>{" "}
        <strong>está sincronizando?</strong> <strong>está configurada?</strong> — porque uma resposta não prova a
        outra. <strong>OK</strong> só aparece com atividade observada e recente; <strong>Observado</strong> é
        atividade sem régua de frescor (uso sob demanda), com a data ao lado; <strong>Sem atividade</strong> é o
        que nunca rodou; <strong>Não verificável</strong> quer dizer que não há coletor daqui — e a tela diz onde a
        resposta mora. Nada aqui é ação: cada card aponta para a tela que manda.
      </p>

      {falhas.length > 0 && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
          Leituras que falharam neste carregamento: {falhas.join(" · ")}
        </p>
      )}

      <div style={{ display: "grid", gap: "var(--sb-space-3)" }}>
        {cards.map((card) => (
          <section key={card.id} aria-label={card.label} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
              <h2 style={{ margin: 0, fontSize: "1.0625rem" }}>{card.label}</h2>
              <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
                {card.links.map((link, index) => (
                  <span key={link.href}>
                    {index > 0 && " · "}
                    <Link href={link.href}>{link.label}</Link>
                  </span>
                ))}
              </span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
                <thead>
                  <tr>
                    <th style={th}>Dimensão</th>
                    <th style={th}>Estado</th>
                    <th style={th}>O que foi observado</th>
                    <th style={th}>Quando</th>
                  </tr>
                </thead>
                <tbody>
                  <DimensionRow label={DIMENSION_LABEL.connection} dimension={card.connection} />
                  <DimensionRow label={DIMENSION_LABEL.sync} dimension={card.sync} />
                  <DimensionRow label={DIMENSION_LABEL.configuration} dimension={card.configuration} />
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      <p style={{ margin: "var(--sb-space-3) 0 0", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        Fora desta versão, por decisão do item: painel de segredos, provisionamento de nuvem e conectores sem
        necessidade medida. Reconectar uma conta continua em Contas ML; reprocessar uma importação, em Importações.
      </p>
    </Shell>
  );
}
