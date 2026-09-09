import type { ReactNode } from "react";

import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill, type PillTone } from "../../components/state-pill";
import { TOM, tomDeStatus } from "../../components/tone";
import { formatCount, formatDateTime } from "../../lib/format";
import { mlAccountStatusLabel, statusTone, runStatusLabel } from "../../lib/labels";
import { sanitizeErrorText } from "../../lib/sanitize";
import { createClient } from "../../lib/supabase/server";
import { classifyResourceFreshness, failureRateLabel, resourceLabel } from "../../lib/sync-health";
import type { SyncVerdict } from "../../lib/sync-health";
import { currentMembership } from "../../lib/membership";

// O título da aba segue o <h1> e o item da navegação, que dizem
// "Sincronização" (o nome do frame). Três nomes para a mesma tela é o
// tipo de coisa que faz alguém procurar a tela errada.
export const metadata = { title: "Sincronização — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Saúde da Sincronização POR RECURSO (Fase 5C, D-143).
 *
 * A versão anterior media o frescor de UM recurso (orders) e contava erros
 * de 24h. Medido antes de reescrever: `visits` falhava 123 de 145 execuções
 * (85%, rate limit 429) e `fulfillment` nunca teve uma rodada `done` — e a
 * tela não mostrava nenhum dos dois.
 *
 * Três verdades que a tela agora separa, porque são três coisas:
 *
 * 1. **Reconciliação** (permanente): o indicador honesto é frescor CONTRA A
 *    CADÊNCIA do job — visits roda 1x/dia, messages a cada 10 min; o mesmo
 *    limiar para os dois carimbaria "atrasada" uma sincronização saudável.
 * 2. **Backfill** (finito): "não rodou nas últimas 24h" é o estado normal de
 *    um backfill concluído. Mostra o cursor (`backfill_covered_until`) e a
 *    conclusão — nunca um selo de atraso, nunca uma porcentagem inventada.
 * 3. **Processamento nosso** (métricas recalculadas): o ML pode estar em dia
 *    e o recálculo parado — é onde os gargalos aparecem (PRD 2026-08-28).
 */

/*
  O veredito virou PÍLULA, e não texto colorido em negrito: o Figma tem UMA
  forma de estado (o chip retangular), e pintar a célula era a quinta forma
  que a auditoria de fidelidade contou (D-246).

  `sem_cadencia` continua NULO de propósito — recurso sem cadência mapeada não
  ganha selo, e a tela mostra as datas cruas. Um selo chutado valeria menos.
*/
const VERDICT_TONE: Record<SyncVerdict, PillTone | null> = {
  ok: { tom: "ok", label: "Em dia" },
  atencao: { tom: "atencao", label: "Atrasando" },
  critico: { tom: "perigo", label: "Atrasada" },
  nunca: { tom: "neutro", label: "Nunca sincronizado" },
  sem_cadencia: null,
};


/*
  O mapa de rótulos MORAVA AQUI, e é por isso que ele divergiu do mapa de
  cadências em `lib/sync-health.ts`: dois donos para o mesmo conjunto de
  recursos (D-224). `order_financials` tinha cadência no mapa irmão e nenhuma
  entrada nos dois daqui — a tela imprimia a chave do banco e um travessão.
  Agora nome e cadência moram juntos, e `resourceLabel` os lê (D-273).
*/

const SEVERITY_TONE: Record<string, PillTone> = {
  informativo: { tom: "neutro", label: "Informativo" },
  importante: { tom: "atencao", label: "Importante" },
  critico: { tom: "perigo", label: "Crítico" },
};

interface HealthRow {
  ml_account_id: string;
  account_label: string;
  resource: string;
  channel: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_reason: string | null;
  last_success_at: string | null;
  latest_record_at: string | null;
  runs_24h: number;
  failed_24h: number;
  items_24h: number;
}

interface ProcessingRow {
  ml_account_id: string;
  account_label: string;
  latest_metric_date: string | null;
  last_computed_at: string | null;
}

interface EventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  severity: string;
  occurred_at: string;
  ml_accounts: { label: string } | null;
}

export default async function SincronizacaoPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const now = new Date();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Sincronização</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const [accountsResult, healthResult, processingResult, eventsResult] = await Promise.all([
    supabase
      .from("ml_accounts")
      .select("id, label, slug, status, last_error, backfill_covered_until")
      .order("label", { ascending: true }),
    supabase.rpc("get_sync_health", { p_organization_id: organizationId }),
    supabase.rpc("get_processing_health", { p_organization_id: organizationId }),
    supabase
      .from("domain_events")
      .select("id, event_type, entity_type, entity_id, severity, occurred_at, ml_accounts(label)")
      .order("occurred_at", { ascending: false })
      .limit(30),
  ]);

  const accounts = accountsResult.data ?? [];
  const health = (healthResult.data ?? []) as HealthRow[];
  const processing = (processingResult.data ?? []) as ProcessingRow[];
  const events = (eventsResult.data ?? []) as EventRow[];

  // Falha em QUALQUER uma das quatro: mostrar erro, nunca "sem dado" (D-067)
  // — numa tela que existe para pegar exatamente esse tipo de problema.
  const error =
    accountsResult.error ?? healthResult.error ?? processingResult.error ?? eventsResult.error;

  const reconciliation = health.filter((row) => row.channel === "reconciliation");
  const backfill = health.filter((row) => row.channel === "backfill");

  /*
    O veredito de cada linha, calculado UMA vez: a faixa conta o mesmo array
    que a tabela imprime, então as partes fecham com o total por construção —
    e não porque duas contagens parecidas deram no mesmo (D-265).
  */
  const vereditos = reconciliation.map((row) => ({
    row,
    verdict: classifyResourceFreshness(row.resource, row.channel, row.last_success_at, now),
  }));

  const quantos = (v: SyncVerdict): string =>
    formatCount(vereditos.filter((item) => item.verdict === v).length);

  /*
    SEIS células: o total e as CINCO partes. `sem_cadencia` entra mesmo
    esperando zero — é a célula que denuncia um recurso novo no banco sem
    entrada em `RECONCILIATION_RESOURCE`, que foi exatamente o defeito desta
    fatia (D-273). Esconder o balde vazio devolveria o problema ao silêncio.

    O frame conta CONTAS (Atualizadas 3, Com Atenção 1, Com Erro 0), e esta
    faixa conta RECURSOS. Contar contas é o que a versão anterior desta tela
    fazia antes de D-143, e a medição que a derrubou continua valendo: uma
    conta "atualizada" pode ter visitas falhando 85% das vezes. Conta não é
    unidade de frescor; recurso é.
  */
  const celulas: KpiCellData[] = [
    {
      label: "Recursos monitorados",
      formula: "Linhas de reconciliação: uma por conta e recurso, o mesmo conjunto da tabela abaixo.",
      value: formatCount(reconciliation.length),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Em dia",
      formula: "Último sucesso dentro de 2 ciclos da cadência do recurso.",
      value: quantos("ok"),
      previous: null,
      tom: "ok",
    },
    {
      label: "Atrasando",
      formula: "Último sucesso entre 2 e 4 ciclos atrás.",
      value: quantos("atencao"),
      previous: null,
      tom: "atencao",
    },
    {
      label: "Atrasada",
      formula: "Último sucesso há mais de 4 ciclos.",
      value: quantos("critico"),
      previous: null,
      tom: "perigo",
    },
    {
      label: "Nunca sincronizado",
      formula: "Nenhuma execução bem-sucedida registrada para esta conta e recurso.",
      value: quantos("nunca"),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Sem cadência",
      formula: "Recurso sem cadência mapeada — não recebe veredito, e a tela mostra as datas cruas.",
      value: quantos("sem_cadencia"),
      previous: null,
      tom: "neutro",
      ressalva: "esperado zero",
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / DADOS E PROCESSAMENTOS"
        title="Sincronização"
        subtitle="Por conta e por recurso, contra a cadência real de cada job. Reconciliação é permanente (o indicador é frescor); backfill é finito (o indicador é o cursor); e o recálculo de métricas é trabalho nosso, medido em separado."
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <>
          <KpiStrip cells={celulas} />

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Contas conectadas"
              subtitle="O estado da conexão de cada conta. Conta revogada não sincroniza, e a linha da tabela abaixo continua existindo — por isso as duas coisas aparecem separadas."
            >
              <div className="sb-panel-body">
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--sb-space-2)",
                  }}
                >
                  {accounts.map((account) => {
                    const tone = {
                      tom: tomDeStatus(statusTone(account.status)),
                      label: mlAccountStatusLabel(account.status),
                    };

                    return (
                      <li
                        key={account.id}
                        style={{
                          border: "1px solid var(--sb-border)",
                          borderLeft: `3px solid ${TOM[tone.tom].color}`,
                          borderRadius: "var(--sb-radius)",
                          padding: "0.375rem 0.75rem",
                          fontSize: "0.75rem",
                          display: "flex",
                          gap: "var(--sb-space-2)",
                          alignItems: "baseline",
                        }}
                      >
                        <strong>{account.label}</strong>
                        <StatePill tone={tone} />
                        {account.status === "ERROR" && account.last_error !== null && (
                          <span style={{ color: "var(--sb-danger)" }}>{sanitizeErrorText(account.last_error)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Panel>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Sincronização contínua"
              subtitle="Dado puxado do Mercado Livre. O veredito compara a idade do último sucesso com a cadência DAQUELE recurso — pedidos a cada hora, visitas uma vez por dia."
            >
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th>Recurso</th>
                      <th>Situação</th>
                      <th>Último sucesso</th>
                      <th>Último dado</th>
                      <th className="sb-num">Itens (24h)</th>
                      <th className="sb-num">Falhas (24h)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vereditos.map(({ row, verdict }) => {
                      const tone = VERDICT_TONE[verdict];
                      const failures = failureRateLabel(row.runs_24h, row.failed_24h);

                      return (
                        <tr key={`${row.ml_account_id}:${row.resource}`}>
                          <td>{row.account_label}</td>
                          <td>{resourceLabel(row.resource)}</td>
                          <td style={{ whiteSpace: "normal" }}>
                            {tone === null ? "—" : <StatePill tone={tone} />}
                            {/*
                              Falha alta com sucesso recente é estado próprio: o
                              caso real é visitas com 85% de falha por 429 e ainda
                              assim um sucesso diário — o frescor fica "Em dia"
                              enquanto a cobertura degrada. O alerta não substitui
                              o veredito; soma-se a ele.
                            */}
                            {failures !== null && (
                              <div style={{ color: "var(--sb-danger)", fontSize: "0.625rem", marginTop: "0.25rem" }}>
                                {failures}
                              </div>
                            )}
                            {row.last_run_status !== null &&
                              row.last_run_status !== "done" &&
                              row.last_run_status !== "partial" &&
                              row.last_run_reason !== null && (
                                <div
                                  style={{ color: "var(--sb-text-soft)", fontSize: "0.625rem", marginTop: "0.25rem" }}
                                >
                                  última falha: {sanitizeErrorText(row.last_run_reason, 80)}
                                </div>
                              )}
                          </td>
                          <td>{formatDateTime(row.last_success_at)}</td>
                          <td>{formatDateTime(row.latest_record_at)}</td>
                          <td className="sb-num">{formatCount(row.items_24h)}</td>
                          <td className="sb-num" style={{ color: row.failed_24h > 0 ? "var(--sb-danger)" : undefined }}>
                            {formatCount(row.failed_24h)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {reconciliation.length === 0 && (
                <div className="sb-panel-body">
                  <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                    Nenhuma execução de reconciliação registrada ainda — nem sucesso nem falha. Isto é ausência de
                    registro, não sincronização em dia.
                  </p>
                </div>
              )}
            </Panel>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Backfill"
              subtitle="Histórico, e portanto FINITO: não ter rodado nas últimas 24h é o estado normal de um backfill concluído. Por isso aqui não há selo de atraso nem porcentagem — o indicador é o cursor."
            >
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th>Recurso</th>
                      <th>Última execução</th>
                      <th>Coberto até</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backfill.map((row) => {
                      const account = accounts.find((a) => a.id === row.ml_account_id);

                      return (
                        <tr key={`${row.ml_account_id}:${row.resource}:bf`}>
                          <td>{row.account_label}</td>
                          <td>{resourceLabel(row.resource)}</td>
                          <td>{formatDateTime(row.last_run_at)}</td>
                          {/*
                            `backfill_covered_until` era gravado e nunca lido — o
                            "ganho barato" do ROADMAP. É o cursor real: até onde a
                            história já foi puxada, sem inventar porcentagem
                            (não existe denominador confiável para "quanto falta").
                          */}
                          <td>{formatDateTime(account?.backfill_covered_until ?? null)}</td>
                          <td>{row.last_run_status === null ? "—" : runStatusLabel(row.last_run_status)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {backfill.length === 0 && (
                <div className="sb-panel-body">
                  <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                    Nenhum backfill registrado.
                  </p>
                </div>
              )}
            </Panel>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Métricas recalculadas"
              subtitle="Dado processado por nós. O Mercado Livre pode estar em dia e o recálculo parado — é onde os gargalos aparecem."
            >
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th>Métricas calculadas até</th>
                      <th>Último recálculo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processing.map((row) => (
                      <tr key={row.ml_account_id}>
                        <td>{row.account_label}</td>
                        <td>{row.latest_metric_date ?? "—"}</td>
                        <td>{formatDateTime(row.last_computed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Eventos recentes"
              subtitle="As 30 mudanças mais recentes registradas pelo próprio banco em domain_events."
            >
              <div className="sb-panel-body">
                {events.length === 0 && (
                  <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                    Nenhum evento registrado ainda.
                  </p>
                )}

                {events.length > 0 && (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {events.map((event) => {
                      const tone = SEVERITY_TONE[event.severity] ?? { tom: "neutro" as const, label: event.severity };

                      return (
                        <li
                          key={event.id}
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "baseline",
                            gap: "var(--sb-space-2)",
                            padding: "var(--sb-space-2) 0",
                            borderTop: "1px solid var(--sb-table-rule)",
                            fontSize: "0.75rem",
                          }}
                        >
                          <StatePill tone={tone} />
                          <span style={{ fontWeight: 600 }}>{event.event_type}</span>
                          <span className="sb-mono">
                            {event.entity_type} {event.entity_id}
                          </span>
                          {/* Nulo para eventos organizacionais sem conta (D-054). */}
                          <span style={{ color: "var(--sb-text-soft)" }}>{event.ml_accounts?.label ?? "Estoque"}</span>
                          <span style={{ color: "var(--sb-text-soft)", marginLeft: "auto", whiteSpace: "nowrap" }}>
                            {formatDateTime(event.occurred_at)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Panel>
          </div>

          {/*
            "EXECUÇÕES RECENTES" DO FRAME NÃO ENTRA, e são quatro medições, não
            uma preferência — o detalhe está em D-273. Em resumo: job_runs não
            é legível pela web (RLS ligada, ZERO policies, e `authenticated` sem
            SELECT); a coluna "Conta" do frame não tem fonte (zero colunas de
            conta na tabela); e 65% das execuções são de um job só
            (`sync.webhook.received`, 32.777 de 50.808 em 7 dias), então uma
            lista das "mais recentes" mostraria 25 webhooks e esconderia
            justamente as linhas que o frame desenha.

            "Sincronizar agora" e "Filtrar" ficam fora pela linha de D-264 e
            D-269: a tela não escreve, e dar-lhe um gatilho de sincronização é
            funcionalidade com decisão de autorização própria.
          */}
        </>
      )}
    </Shell>
  );
}
