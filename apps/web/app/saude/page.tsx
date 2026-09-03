import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { fetchApiHealth } from "../../lib/api-health";
import { formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { classifyJobFreshness } from "../../lib/sync-health";
import type { SyncVerdict } from "../../lib/sync-health";

export const metadata = { title: "Saúde do Sistema — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Saúde do Sistema (D-176, trilha 8A) — detectar DRIFT entre o que se espera
 * e o que está no ar.
 *
 * A pergunta que esta tela responde é a que esta própria sessão de
 * desenvolvimento precisou fazer várias vezes sem ter onde olhar: **o código
 * que está rodando é o código que eu acho que está rodando?**
 *
 * Três regras que o item do ROADMAP impõe e que valem mais que qualquer
 * número bonito aqui:
 *
 * 1. **Nada deriva de documentação.** Nenhum valor desta tela vem do
 *    HANDOFF, do ROADMAP ou de constante escrita à mão. Vem do banco
 *    (`get_system_health`), do `/health` da API e das variáveis que a
 *    Vercel injeta no build.
 * 2. **`UNKNOWN` quando medir falha** — e UNKNOWN aparece como UNKNOWN, não
 *    como "ok". Uma API que não responde, um commit que não foi injetado ou
 *    uma variável ausente viram "não medido", com o motivo ao lado.
 * 3. **Sem permissões novas de nuvem.** A tela não pergunta nada ao Google
 *    Cloud (o item lista "permissões cloud excessivas" como risco). Para
 *    jobs, ela observa o EFEITO — `job_runs` diz se rodou — em vez do
 *    agendamento. Um scheduler que existe e nunca dispara é indistinguível
 *    de um ausente para quem depende do resultado.
 *
 * Fora desta versão, por decisão do próprio item: acionar deploy, migration,
 * rollback ou recriação de scheduler pela interface.
 */

/**
 * Veredito de frescor por job, contra a CADÊNCIA de cada um (D-219).
 *
 * A versão anterior usava um limiar único de 26 h para todos, e o próprio
 * texto da tela admitia a fraqueza ("a idade é informação, não veredito").
 * O incidente de D-217 mostrou o custo: `sync.orders.window` é HORÁRIO e
 * ficou 13 h mudo — catástrofe para ele, folgado sob 26 h, e a tela não
 * disse nada por meio dia.
 *
 * Job sem cadência fixa (webhook, chave suja, backfill) não ganha selo:
 * `sem_cadencia` mostra a idade crua, que é o honesto. Mesma regra de D-143.
 */
const JOB_VERDICT_TONE: Record<SyncVerdict, { color: string; label: string } | null> = {
  ok: { color: "var(--sb-secondary)", label: "Em dia" },
  atencao: { color: "var(--sb-accent-ink)", label: "Atrasando" },
  critico: { color: "var(--sb-danger)", label: "Parado" },
  nunca: { color: "var(--sb-muted-ink)", label: "Nunca rodou" },
  sem_cadencia: null,
};


type Verdict = "CURRENT" | "OUTDATED" | "UNKNOWN";

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "var(--sb-space-3)",
  minWidth: "13rem",
  display: "grid",
  gap: "0.25rem",
};

function verdictColor(verdict: Verdict): string {
  if (verdict === "OUTDATED") return "var(--sb-danger)";
  if (verdict === "UNKNOWN") return "var(--sb-text-soft)";

  return "var(--sb-secondary)";
}

export default async function SaudePage(): Promise<ReactNode> {
  const supabase = await createClient();

  const [healthResult, api] = await Promise.all([supabase.rpc("get_system_health"), fetchApiHealth()]);

  const rows = healthResult.data ?? [];
  // Um instante só para a página inteira: duas chamadas a new Date() dariam
  // vereditos calculados contra relógios diferentes na mesma tabela.
  const agora = new Date();

  // A RPC devolve zero linhas para quem não é ADMIN (a autorização é dela,
  // não desta tela).
  if (healthResult.error === null && rows.length === 0) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Saúde do Sistema</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Esta tela é restrita a ADMIN.</p>
      </Shell>
    );
  }

  const first = rows[0];

  // O commit da web vem da Vercel; localmente não existe, e isso é UNKNOWN
  // honesto, não erro.
  const webCommitFull = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const webCommit = webCommitFull === null ? null : webCommitFull.slice(0, 7);
  const apiCommit = api?.commit ?? null;

  const verdict: Verdict =
    webCommit === null || apiCommit === null ? "UNKNOWN" : webCommit === apiCommit ? "CURRENT" : "OUTDATED";

  const motivoUnknown =
    api === null
      ? "a API não respondeu ao /health"
      : apiCommit === null
        ? "a revisão no ar é anterior ao commit que passou a injetar APP_COMMIT"
        : webCommit === null
          ? "esta build da web não tem VERCEL_GIT_COMMIT_SHA (execução local)"
          : null;

  const jobs = rows.filter((row) => row.job_type !== null);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Saúde do Sistema</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        O que está no ar, medido no ar. Nenhum número desta tela vem de documentação: o commit sai do{" "}
        <span style={{ fontFamily: "ui-monospace, monospace" }}>/health</span> da API e das variáveis de build, a
        migration sai do próprio banco, e os jobs saem do registro do que <strong>aconteceu</strong> — não do que
        foi agendado.
      </p>

      {healthResult.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível ler a saúde do banco: {healthResult.error.message}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--sb-space-3)", flexWrap: "wrap", marginBottom: "var(--sb-space-2)" }}>
        <div style={cardStyle}>
          <span style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--sb-text-soft)" }}>
            Código no ar
          </span>
          <span style={{ fontSize: "1.375rem", fontWeight: 700, color: verdictColor(verdict) }}>{verdict}</span>
          <span style={{ fontSize: "0.6875rem", color: "var(--sb-muted-ink)", fontFamily: "ui-monospace, monospace" }}>
            web {webCommit ?? "—"} · api {apiCommit ?? "—"}
          </span>
          {motivoUnknown !== null && (
            <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>{motivoUnknown}</span>
          )}
        </div>

        <div style={cardStyle}>
          <span style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--sb-text-soft)" }}>
            Migration aplicada
          </span>
          <span style={{ fontSize: "1.375rem", fontVariantNumeric: "tabular-nums" }}>
            {first?.db_migrations_count ?? "—"}
          </span>
          <span style={{ fontSize: "0.6875rem", color: "var(--sb-muted-ink)", fontFamily: "ui-monospace, monospace" }}>
            {first?.db_migration_version ?? "—"}
          </span>
          {first !== undefined && (
            <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              {first.db_migration_name} · {formatDateTime(first.db_migration_applied_at)}
            </span>
          )}
        </div>

        <div style={cardStyle}>
          <span style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "var(--sb-text-soft)" }}>
            API
          </span>
          <span style={{ fontSize: "1.375rem", fontWeight: 700, color: api === null ? "var(--sb-danger)" : undefined }}>
            {api === null ? "sem resposta" : "no ar"}
          </span>
          {api?.startedAt !== undefined && api.startedAt !== null && (
            <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              desde {formatDateTime(api.startedAt)}
            </span>
          )}
        </div>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-4)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        <strong>OUTDATED</strong> significa que a web e a API estão em commits diferentes — normal por alguns
        minutos durante um deploy, e sinal de drift se persistir. <strong>UNKNOWN</strong> nunca é lido como
        “tudo certo”: é a tela dizendo que não conseguiu medir, e por quê.
      </p>

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Jobs — última execução observada</h2>

      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        De <span style={{ fontFamily: "ui-monospace, monospace" }}>job_runs</span>: o que rodou de verdade. Um job
        que sumiu do agendador e um que falha em silêncio aparecem igual aqui, e o veredito é contra a
        <strong> cadência de cada um</strong> — 13h de silêncio é catástrofe num job horário e normal num diário.
        Job movido por evento (webhook, chave suja, backfill) não recebe selo: a idade crua é o honesto.
      </p>

      {jobs.length === 0 && healthResult.error === null && (
        <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
          Nenhuma execução registrada — o que também é um sinal, não um vazio.
        </p>
      )}

      {jobs.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
            <thead>
              <tr>
                <th style={th}>Job</th>
                <th style={th}>Último estado</th>
                <th style={th}>Quando</th>
                <th style={th}>Frescor</th>
                <th style={{ ...th, textAlign: "right" }}>Idade (h)</th>
                <th style={{ ...th, textAlign: "right" }}>Falhas 24h</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const veredito = classifyJobFreshness(job.job_type ?? "", job.job_last_run_at, agora);
                const tom = JOB_VERDICT_TONE[veredito];

                return (
                  <tr key={job.job_type ?? ""}>
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: "0.8125rem" }}>
                      {job.job_type}
                    </td>
                    <td
                      style={{
                        ...td,
                        color: job.job_status === "failed" ? "var(--sb-danger)" : undefined,
                      }}
                    >
                      {job.job_status}
                    </td>
                    <td style={td}>
                      {job.job_last_run_at === null ? "—" : formatDateTime(job.job_last_run_at)}
                    </td>
                    <td style={{ ...td, color: tom?.color, fontWeight: tom === null ? undefined : 600 }}>
                      {tom?.label ?? "—"}
                    </td>
                    <td style={{ ...tdNumber, color: tom?.color }}>{job.job_age_hours ?? "—"}</td>
                    <td
                      style={{
                        ...tdNumber,
                        color: job.job_failures_24h > 0 ? "var(--sb-danger)" : undefined,
                      }}
                    >
                      {job.job_failures_24h}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
