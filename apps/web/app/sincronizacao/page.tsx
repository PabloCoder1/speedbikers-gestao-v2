import type { ReactNode } from "react";

import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill, type PillTone } from "../../components/state-pill";
import { tomDeStatus } from "../../components/tone";
import { formatCount, formatDateTime, formatDay } from "../../lib/format";
import { mlAccountStatusLabel, statusTone, runStatusLabel } from "../../lib/labels";
import { sanitizeErrorText } from "../../lib/sanitize";
import { createClient } from "../../lib/supabase/server";
import {
  calculateBackfillProgress,
  classifyResourceFreshness,
  failureRateLabel,
  resourceLabel,
} from "../../lib/sync-health";
import type { SyncVerdict } from "../../lib/sync-health";
import { currentMembership } from "../../lib/request-membership";

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
 *    conclusão e a cobertura estimada contra a janela recuperável de 365
 *    dias. O percentual só chega a 100 quando o cursor alcança a conexão.
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
  /** A passada do recálculo, que anda mesmo quando nada muda (D-304). */
  last_refreshed_at: string | null;
  last_rows_written: number | null;
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

/**
 * A janela da lista de falhas (D-291). Sete dias é a mesma janela em que a
 * medição foi feita (473 falhas, 16 assinaturas no Dev) e a mesma do resto
 * desta tela; a RPC aceita de 1 a 90.
 */
const FAILURE_WINDOW_DAYS = 7;

export default async function SincronizacaoPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const now = new Date();

  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Sincronização</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const [accountsResult, healthResult, processingResult, eventsResult, failuresResult] = await Promise.all([
    supabase
      .from("ml_accounts")
      .select("id, label, slug, status, last_error, connected_at, backfill_covered_until")
      .order("label", { ascending: true }),
    supabase.rpc("get_sync_health", { p_organization_id: organizationId }),
    supabase.rpc("get_processing_health", { p_organization_id: organizationId }),
    supabase
      .from("domain_events")
      .select("id, event_type, entity_type, entity_id, severity, occurred_at, ml_accounts(label)")
      .order("occurred_at", { ascending: false })
      .limit(30),
    /*
      A LISTA DE FALHAS (D-291) — o item que D-273 deixou aberto por escrito.
      Ela não lê `job_runs`: a tabela continua com RLS e ZERO policies. Quem
      lê é a RPC `security definer`, que refaz a autorização (ADMIN) dentro e
      devolve AGREGADO — nunca a linha de execução.
    */
    supabase.rpc("get_job_failures", { p_days: FAILURE_WINDOW_DAYS, p_limit: 30 }),
  ]);

  const accounts = accountsResult.data ?? [];
  const health = (healthResult.data ?? []) as HealthRow[];
  const processing = (processingResult.data ?? []) as ProcessingRow[];
  const events = (eventsResult.data ?? []) as EventRow[];
  const failures = failuresResult.data ?? [];

  // Falha em QUALQUER uma das cinco: mostrar erro, nunca "sem dado" (D-067)
  // — numa tela que existe para pegar exatamente esse tipo de problema.
  const error =
    accountsResult.error ??
    healthResult.error ??
    processingResult.error ??
    eventsResult.error ??
    failuresResult.error;

  /*
    ZERO LINHAS TEM DOIS SIGNIFICADOS, e a tela precisa saber qual é (D-067):
    a RPC devolve vazio tanto para "nenhuma falha na janela" quanto para "você
    não é ADMIN", porque a autorização dela é silênciosa de propósito (erro
    vazaria a existência do dado). Quem desempata aqui é o próprio papel do
    chamador, que a página já tem em mãos.
  */
  const ehAdmin = membership.role === "ADMIN";

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

  const contas = accounts.map((account) => {
    const recursos = vereditos.filter(({ row }) => row.ml_account_id === account.id);
    const progresso = calculateBackfillProgress(account.connected_at, account.backfill_covered_until, now);
    const processamento = processing.find((row) => row.ml_account_id === account.id) ?? null;
    const emDia = recursos.filter(({ verdict }) => verdict === "ok").length;
    const criticos = recursos.filter(({ verdict }) => verdict === "critico").length;
    const nunca = recursos.filter(({ verdict }) => verdict === "nunca" || verdict === "sem_cadencia").length;
    const falhas24h = recursos.reduce((total, { row }) => total + row.failed_24h, 0);
    const itens24h = recursos.reduce((total, { row }) => total + row.items_24h, 0);
    const ultimoSucesso = recursos.reduce<string | null>((maisRecente, { row }) => {
      if (row.last_success_at === null) return maisRecente;
      if (maisRecente === null) return row.last_success_at;
      return new Date(row.last_success_at).getTime() > new Date(maisRecente).getTime()
        ? row.last_success_at
        : maisRecente;
    }, null);

    let confianca: PillTone;
    let orientacao: string;

    if (account.status !== "CONNECTED") {
      confianca = { tom: "perigo", label: "Sincronização interrompida" };
      orientacao = "A conexão precisa ser restabelecida antes de usar os dados desta conta como atuais.";
    } else if (criticos > 0 || falhas24h > 0) {
      confianca = { tom: "perigo", label: "Dados exigem atenção" };
      orientacao = `${formatCount(criticos)} ${criticos === 1 ? "recurso atrasado" : "recursos atrasados"} e ${formatCount(falhas24h)} ${falhas24h === 1 ? "falha" : "falhas"} nas últimas 24h. Confira o detalhamento antes de decidir.`;
    } else if (progresso.state !== "complete") {
      confianca = { tom: "atencao", label: "Histórico em carregamento" };
      orientacao = "Os dados recentes podem estar em dia, mas o histórico de pedidos ainda não foi percorrido por completo.";
    } else if (nunca > 0) {
      confianca = { tom: "atencao", label: "Cobertura parcial" };
      orientacao = `${formatCount(nunca)} ${nunca === 1 ? "recurso ainda não tem" : "recursos ainda não têm"} sucesso registrado. Use somente as áreas já sincronizadas.`;
    } else {
      confianca = { tom: "ok", label: "Base pronta para análise" };
      orientacao = "O histórico recuperável de pedidos foi percorrido e os recursos monitorados estão em dia.";
    }

    return {
      account,
      recursos,
      progresso,
      processamento,
      emDia,
      criticos,
      falhas24h,
      itens24h,
      ultimoSucesso,
      confianca,
      orientacao,
    };
  });

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
        subtitle="Veja primeiro se os dados de cada conta estão prontos para análise. Depois, investigue frescor, histórico, processamento e falhas sem misturar sinais diferentes."
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <>
          <nav className="sb-sync-nav" aria-label="Seções da sincronização">
            <a href="#contas"><Icone nome="loja" tamanho={14} /> Contas</a>
            <a href="#recursos"><Icone nome="sincronizar" tamanho={14} /> Recursos</a>
            <a href="#historico"><Icone nome="barras" tamanho={14} /> Histórico</a>
            <a href="#processamento"><Icone nome="ciclo" tamanho={14} /> Processamento</a>
            <a href="#falhas"><Icone nome="pulso" tamanho={14} /> Falhas</a>
          </nav>

          <section id="contas" className="sb-sync-overview" aria-labelledby="sync-overview-title">
            <div className="sb-sync-section-head">
              <div>
                <span className="sb-eyebrow">LEITURA RÁPIDA</span>
                <h2 id="sync-overview-title">Confiança dos dados por conta</h2>
                <p>
                  O percentual mede somente o histórico de pedidos recuperável no Mercado Livre. A situação ao lado
                  combina conexão, frescor e falhas para evitar um “100%” enganoso.
                </p>
              </div>
              <span className="sb-sync-window">janela histórica: até 12 meses</span>
            </div>

            {contas.length === 0 && (
              <div className="sb-sync-empty">
                Nenhuma conta Mercado Livre cadastrada. Conecte uma conta para começar a medir a cobertura.
              </div>
            )}

            <div className="sb-sync-account-grid">
              {contas.map((conta) => {
                const progressoLabel =
                  conta.progresso.percent === null
                    ? "Não mensurável"
                    : `${String(conta.progresso.percent)}%`;
                const connectionTone: PillTone = {
                  tom: tomDeStatus(statusTone(conta.account.status)),
                  label: mlAccountStatusLabel(conta.account.status),
                };

                return (
                  <article className="sb-sync-account" key={conta.account.id} data-tone={conta.confianca.tom}>
                    <header className="sb-sync-account-head">
                      <div className="sb-sync-account-name">
                        <span className="sb-sync-account-icon"><Icone nome="loja" tamanho={17} /></span>
                        <div>
                          <h3>{conta.account.label}</h3>
                          <span>@{conta.account.slug}</span>
                        </div>
                      </div>
                      <div className="sb-sync-account-pills">
                        <StatePill tone={connectionTone} />
                        <StatePill tone={conta.confianca} />
                      </div>
                    </header>

                    <div className="sb-sync-progress-copy">
                      <div>
                        <span>Histórico de pedidos extraído</span>
                        <strong>{progressoLabel}</strong>
                        <code className="sb-sync-metric-id">cobertura_historico_pedidos</code>
                      </div>
                      <small>
                        {conta.progresso.state === "complete"
                          ? "Todo o período recuperável foi percorrido"
                          : conta.account.backfill_covered_until === null
                            ? "A carga histórica ainda não começou"
                            : `carregado até ${formatDay(conta.account.backfill_covered_until)}`}
                      </small>
                    </div>

                    {conta.progresso.percent === null ? (
                      <div className="sb-sync-progress sb-sync-progress-unknown" aria-label="Progresso não mensurável" />
                    ) : (
                      <div
                        className="sb-sync-progress"
                        role="progressbar"
                        aria-label={`Histórico de pedidos extraído de ${conta.account.label}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={conta.progresso.percent}
                      >
                        <span style={{ width: `${String(conta.progresso.percent)}%` }} />
                      </div>
                    )}

                    <p className="sb-sync-guidance">{conta.orientacao}</p>

                    <dl className="sb-sync-account-facts">
                      <div>
                        <dt>Recursos em dia</dt>
                        <dd>{formatCount(conta.emDia)} de {formatCount(conta.recursos.length)}</dd>
                      </div>
                      <div>
                        <dt>Itens nas últimas 24h</dt>
                        <dd>{formatCount(conta.itens24h)}</dd>
                      </div>
                      <div>
                        <dt>Falhas nas últimas 24h</dt>
                        <dd className={conta.falhas24h > 0 ? "sb-sync-danger" : undefined}>{formatCount(conta.falhas24h)}</dd>
                      </div>
                      <div>
                        <dt>Último sucesso</dt>
                        <dd>{formatDateTime(conta.ultimoSucesso)}</dd>
                      </div>
                      <div>
                        <dt>Métricas calculadas até</dt>
                        <dd>{conta.processamento?.latest_metric_date ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Conectada em</dt>
                        <dd>{formatDateTime(conta.account.connected_at)}</dd>
                      </div>
                    </dl>

                    {conta.account.status === "ERROR" && conta.account.last_error !== null && (
                      <p className="sb-sync-account-error">{sanitizeErrorText(conta.account.last_error)}</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <div id="recursos" className="sb-sync-section-anchor">
            <KpiStrip cells={celulas} />
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

          <div id="historico" className="sb-sync-section-anchor" style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Backfill"
              subtitle="Carga finita do histórico de pedidos. A porcentagem estima quanto da janela recuperável de até 12 meses já foi percorrido; o cursor mostra a evidência concreta."
            >
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th>Recurso</th>
                      <th>Última execução</th>
                      <th>Progresso</th>
                      <th>Coberto até</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backfill.map((row) => {
                      const account = accounts.find((a) => a.id === row.ml_account_id);
                      const progresso = calculateBackfillProgress(
                        account?.connected_at ?? null,
                        account?.backfill_covered_until ?? null,
                        now,
                      );

                      return (
                        <tr key={`${row.ml_account_id}:${row.resource}:bf`}>
                          <td>{row.account_label}</td>
                          <td>{resourceLabel(row.resource)}</td>
                          <td>{formatDateTime(row.last_run_at)}</td>
                          <td>
                            {progresso.percent === null ? "Não mensurável" : `${String(progresso.percent)}%`}
                          </td>
                          {/*
                            `backfill_covered_until` era gravado e nunca lido — o
                            "ganho barato" do ROADMAP. É o cursor real: até onde a
                            história já foi puxada. A porcentagem usa a janela
                            recuperável de 365 dias; o cursor continua exposto
                            porque é a evidência concreta do avanço.
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

          <div id="processamento" className="sb-sync-section-anchor" style={{ marginTop: "var(--sb-space-3)" }}>
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
                      {/*
                        DUAS DATAS, e elas respondem perguntas diferentes
                        (D-304): "última mudança" é quando algum número daquela
                        conta mudou; "última conferência" é quando o recálculo
                        passou por lá. Divergirem é o estado SAUDÁVEL de um dia
                        sem venda — a segunda parar é que é defeito.
                      */}
                      <th>Última mudança</th>
                      <th>Última conferência</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processing.map((row) => (
                      <tr key={row.ml_account_id}>
                        <td>{row.account_label}</td>
                        <td>{row.latest_metric_date ?? "—"}</td>
                        <td>{formatDateTime(row.last_computed_at)}</td>
                        <td>{formatDateTime(row.last_refreshed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <div id="eventos" className="sb-sync-section-anchor" style={{ marginTop: "var(--sb-space-3)" }}>
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

          <div id="falhas" className="sb-sync-section-anchor" style={{ marginTop: "var(--sb-space-3)" }}>
            <Panel
              title="Execuções que falharam"
              subtitle={`Agrupadas por job e por MOTIVO, nos últimos ${String(FAILURE_WINDOW_DAYS)} dias. Corridas de quatro ou mais dígitos viram # na assinatura do motivo — assim o código HTTP sobrevive e o id da entidade não fragmenta a lista. No Dev isso reduz 473 falhas de 170 motivos a 16 linhas.`}
            >
              <div className="sb-panel-body">
                {!ehAdmin && (
                  <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                    O log de execução é restrito a ADMIN.
                  </p>
                )}

                {ehAdmin && failures.length === 0 && (
                  <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                    Nenhuma execução falhou nos últimos {FAILURE_WINDOW_DAYS} dias.
                  </p>
                )}

                {ehAdmin && failures.length > 0 && (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Job</th>
                          <th>Motivo</th>
                          <th className="sb-num">Falhas</th>
                          {/*
                            `retryable` é do próprio banco (`job_runs`): true = a
                            fila repete (503); false = a fila descarta (422). A
                            diferença decide quem age — uma se resolve sozinha,
                            a outra não.
                          */}
                          <th className="sb-num">Retentadas</th>
                          <th>Última</th>
                        </tr>
                      </thead>
                      <tbody>
                        {failures.map((row) => (
                          <tr key={`${row.job_type}:${row.reason_signature}`}>
                            <td className="sb-mono">{row.job_type}</td>
                            <td>
                              <span style={{ display: "block", maxWidth: "42rem" }}>{row.reason_signature}</span>
                              {/*
                                O exemplo CRU devolve o id que a assinatura
                                apagou — sem ele a linha não dá para investigar.
                                Só aparece quando difere da assinatura.
                              */}
                              {row.sample_reason !== null && row.sample_reason !== row.reason_signature && (
                                <small style={{ display: "block", color: "var(--sb-text-soft)" }}>
                                  {row.distinct_reasons > 1
                                    ? `${formatCount(row.distinct_reasons)} motivos nesta família · último: `
                                    : "motivo: "}
                                  {row.sample_reason.slice(0, 180)}
                                </small>
                              )}
                            </td>
                            <td className="sb-num">{formatCount(row.failures)}</td>
                            <td className="sb-num">
                              {row.retryable_failures === 0 ? (
                                <span style={{ color: "var(--sb-text-soft)" }} title="a fila descartou: ninguém tenta de novo sozinho">
                                  —
                                </span>
                              ) : (
                                formatCount(row.retryable_failures)
                              )}
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(row.last_failed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Panel>
          </div>

          {/*
            A TABELA "EXECUÇÕES RECENTES" DO FRAME CONTINUA FORA — o que entrou
            em D-291 foi a lista de FALHAS, agrupada, que é outra coisa. As
            quatro medições de D-273 seguem valendo, e uma delas atravessa o
            recorte: 78% das falhas de 7 dias também são de
            `sync.webhook.received` (370 de 473), então nem uma lista crua de
            falhas escaparia do firehose — quem escapa é o agrupamento por
            assinatura de motivo. O resto da recusa segue de pé: a coluna "Conta"
            do frame não tem fonte (zero colunas de conta em `job_runs`), e uma
            lista das "mais recentes" mostraria 25 webhooks — 65% das execuções
            são desse job (32.777 de 50.808 em 7 dias), escondendo justamente as
            linhas que o frame desenha. `job_runs` também continua sem policy
            nenhuma: quem lê é a RPC, nunca a tabela.

            "Sincronizar agora" e "Filtrar" ficam fora pela linha de D-264 e
            D-269: a tela não escreve, e dar-lhe um gatilho de sincronização é
            funcionalidade com decisão de autorização própria.
          */}
        </>
      )}
    </Shell>
  );
}
