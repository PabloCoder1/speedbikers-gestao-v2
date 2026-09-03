import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { fetchApiHealth, apiBaseUrl } from "../../lib/api-health";
import { formatDateTime } from "../../lib/format";
import { describeIntegrations, sanitizeErrorText } from "../../lib/integrations";
import type { Dimension, IntegrationState } from "../../lib/integrations";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Integrações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Integrações (item C/E do ROADMAP, primeira versão — D-231).
 *
 * Uma tela que COMPÕE e APONTA. Nenhuma tabela nova, nenhuma RPC nova,
 * nenhuma permissão de nuvem nova: ela lê em paralelo o que as telas donas já
 * leem (contas ML, saúde da sincronização, jobs, lotes do UpSeller, uso de IA,
 * `/health` da API) e entrega isso a `lib/integrations.ts`, que separa cada
 * integração em três dimensões — **conexão, sincronização e configuração** —
 * porque o item nomeia exatamente essa confusão como o risco: "declarar saúde
 * só por haver configuração".
 *
 * Duas regras que valem mais que qualquer selo verde aqui:
 *
 * 1. **`ok` exige atividade observada.** Configuração existente sem atividade
 *    nunca é verde; e nesta versão NENHUMA configuração é `ok`, porque não há
 *    coletor autenticado para Secret Manager, Cloud Scheduler, painel do
 *    Mercado Livre ou Dashboard do Supabase (o item exclui permissões novas de
 *    nuvem). O honesto é "Não verificável", com o motivo escrito ao lado.
 * 2. **Um dado, um dono (D-224).** Veredito de frescor vem de
 *    `lib/sync-health.ts`, o mesmo de `/sincronizacao` e `/saude`; reconectar
 *    conta continua em `/contas`. Esta tela não tem botão: só links para a
 *    tela que manda.
 *
 * Restrita a ADMIN, como `/saude` — é estado da operação, não do produto.
 */

const STATE_TONE: Record<IntegrationState, { color: string; label: string }> = {
  ok: { color: "var(--sb-secondary)", label: "OK" },
  atencao: { color: "var(--sb-accent-ink)", label: "Atenção" },
  erro: { color: "var(--sb-danger)", label: "Erro" },
  nao_configurado: { color: "var(--sb-muted-ink)", label: "Não configurado" },
  nao_verificavel: { color: "var(--sb-text-soft)", label: "Não verificável" },
};

const DIMENSION_LABEL = {
  connection: "Conexão",
  sync: "Sincronização",
  configuration: "Configuração",
} as const;

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "var(--sb-space-3)",
  display: "grid",
  gap: "var(--sb-space-2)",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.375rem 0.5rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.6875rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.375rem 0.5rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.8125rem",
  verticalAlign: "top",
};

function StatePill({ state }: { state: IntegrationState }): ReactNode {
  const tone = STATE_TONE[state];

  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.0625rem 0.5rem",
        borderRadius: "999px",
        border: `1px solid ${tone.color}`,
        color: tone.color,
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {tone.label}
    </span>
  );
}

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
            <StatePill state={dimension.state} />
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

  // Papel e organização na MESMA linha (D-180). `organization_id` é
  // parâmetro de `get_sync_health`, por isso a leitura vem antes das outras —
  // dependência real, não fila sem motivo.
  const membership = await supabase.from("organization_members").select("organization_id, role").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;
  const isAdmin = membership.data?.role === "ADMIN";

  if (organizationId === null || !isAdmin) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Integrações</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Esta tela é restrita a ADMIN.</p>
      </Shell>
    );
  }

  // Um instante só para a página inteira (mesma razão de /saude).
  const agora = new Date();
  const inicioDoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();

  const [accounts, syncHealth, systemHealth, batches, aiRuns, aiCost, apiHealth] = await Promise.all([
    supabase.from("ml_accounts").select("label, status, connected_at, last_error").order("label"),
    supabase.rpc("get_sync_health", { p_organization_id: organizationId }),
    supabase.rpc("get_system_health"),
    supabase
      .from("erp_import_batches")
      .select("status, created_at, last_error")
      .order("created_at", { ascending: false })
      .limit(1),
    // `count: "exact"` com `limit(1)`: a contagem é do conjunto inteiro e a
    // linha é a mais recente — uma viagem para as duas perguntas (D-185).
    supabase.from("ai_runs").select("created_at", { count: "exact" }).order("created_at", { ascending: false }).limit(1),
    // Soma no banco (regra de docs/ARCHITECTURE.md secao 15), na RPC que
    // D-100 já criou para o teto mensal.
    supabase.rpc("get_ai_monthly_cost_usd", {
      p_organization_id: organizationId,
      p_from: inicioDoMes,
      p_to: agora.toISOString(),
    }),
    fetchApiHealth(),
  ]);

  const cards = describeIntegrations({
    now: agora,
    mlAccounts: accounts.error === null ? accounts.data : null,
    syncHealth: syncHealth.error === null ? syncHealth.data : null,
    // A RPC devolve zero linhas para quem não é ADMIN; aqui já somos.
    jobs: systemHealth.error === null ? systemHealth.data.filter((row) => row.job_type !== null) : null,
    importBatches: batches.error === null ? batches.data : null,
    ai:
      aiRuns.error === null
        ? {
            runs: aiRuns.count ?? 0,
            lastRunAt: aiRuns.data[0]?.created_at ?? null,
            monthCostUsd: aiCost.error === null ? aiCost.data : null,
          }
        : null,
    api: { configured: apiBaseUrl() !== null, health: apiHealth },
    // Observação, não presunção: chegar aqui já leu `organization_members`, e
    // pelo menos uma das leituras acima respondeu sem erro.
    dbReachable: accounts.error === null || batches.error === null || aiRuns.error === null,
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
        outra. <strong>OK</strong> só aparece com atividade observada (um job, um lote, uma leitura que acabou de
        acontecer); configuração existente sem atividade nunca é verde.{" "}
        <strong>Não verificável</strong> quer dizer exatamente isso: não há coletor daqui, e a tela diz onde a
        resposta mora. Nada aqui é ação — cada card aponta para a tela que manda.
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
