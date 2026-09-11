import Link from "next/link";
import type { ReactNode } from "react";

import { AcessoRestrito } from "../../components/acesso-restrito";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill, type PillTone } from "../../components/state-pill";
import { fetchApiHealth } from "../../lib/api-health";
import { formatCount, formatDateTime, formatLatency } from "../../lib/format";
import { runStatusLabel } from "../../lib/labels";
import { sanitizeErrorText } from "../../lib/sanitize";
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
const JOB_VERDICT_TONE: Record<SyncVerdict, PillTone | null> = {
  ok: { tom: "ok", label: "Em dia" },
  atencao: { tom: "atencao", label: "Atrasando" },
  critico: { tom: "perigo", label: "Parado" },
  nunca: { tom: "neutro", label: "Nunca rodou" },
  sem_cadencia: null,
};


type Verdict = "CURRENT" | "OUTDATED" | "UNKNOWN";

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
    return <AcessoRestrito titulo="Saúde do Sistema" />;
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

  /*
    O veredito de cada job, calculado UMA vez: a faixa de dentro do painel
    conta o mesmo array que a tabela imprime (D-265).
  */
  const vereditos = jobs.map((job) => ({
    job,
    veredito: classifyJobFreshness(job.job_type ?? "", job.job_last_run_at, agora),
  }));

  const quantos = (v: SyncVerdict): string =>
    formatCount(vereditos.filter((item) => item.veredito === v).length);

  /*
    A CÉLULA ÂNCORA É "CÓDIGO NO AR", e no lugar dela o frame põe "99,97% de
    uptime em 30 dias".

    Esse número não tem fonte: são ZERO tabelas de incidente, uptime,
    disponibilidade ou SLA no esquema inteiro. Derivá-lo da presença do
    heartbeat seria pior que não mostrá-lo — `system.ping` diz que o worker
    rodou, não que o produto estava disponível para quem usa.

    O que a âncora ganha no lugar é a pergunta que ESTA tela nasceu para
    responder (D-176): o código que está rodando é o código que eu acho que
    está rodando?
  */
  const ambiente: KpiCellData[] = [
    {
      label: "Código no ar",
      formula:
        "Compara o commit da build da web (VERCEL_GIT_COMMIT_SHA) com o que a API responde no /health. UNKNOWN é falha de medição, nunca 'tudo certo'.",
      value: verdict,
      previous: null,
      ressalva: motivoUnknown ?? `web ${webCommit ?? "—"} · api ${apiCommit ?? "—"}`,
      tom: verdict === "CURRENT" ? "ok" : verdict === "OUTDATED" ? "perigo" : "neutro",
    },
    {
      label: "API",
      formula:
        "Resposta do /health da API no Cloud Run, com timeout de 4 s. Sem resposta é sem resposta. O tempo é o desta ida, cronometrado no servidor da web: uma amostra, não média, não p95, não compromisso de tempo de resposta.",
      value: api === null ? "sem resposta" : "no ar",
      previous: null,
      /*
        `exactOptionalPropertyTypes` recusa `ressalva: undefined`, e isso é bom
        aqui: a ressalva ou EXISTE ou a chave não vem. "API no ar sem data de
        início" é uma frase; "API no ar desde undefined" seria outra.

        O TEMPO ENTRA NA RESSALVA, e não na `formula` (D-309): `KpiStrip` só
        imprime `ressalva` como texto — `formula` vira `title`, que ninguém lê
        de passagem e nenhum teste consegue afirmar sem ler atributo. A lição é
        de D-281: o que se afirma precisa aparecer no texto.

        E ele vem com a palavra que o limita. "42 ms" sozinho lê-se como a
        latência da API; "uma ida, agora: 42 ms" lê-se como o que é — uma
        amostra desta renderização, do servidor da web até o Cloud Run.
      */
      ...(api === null
        ? {}
        : {
            ressalva: [
              /*
                `formatLatency` e NÃO `formatCount`: o segundo agrupa milhar em
                pt-BR, e 3842 sairia "3.842 ms" — que se lê como três
                milissegundos e pouco. O tempo mais LENTO que esta medição
                consegue produzir seria o que pareceria mais rápido na tela.
              */
              api.latencyMs === null ? null : `uma ida, agora: ${formatLatency(api.latencyMs)}`,
              api.startedAt === null ? null : `desde ${formatDateTime(api.startedAt)}`,
            ]
              .filter((parte): parte is string => parte !== null)
              .join(" · "),
          }),
      /*
        `tom` NÃO PINTA A CÉLULA — ele veste o chip "ver lista", e esta célula
        não tem chip. Sem `destaque`, "sem resposta" sairia no mesmo navy de "no
        ar", e depois desta fatia o número passaria a ser a única coisa que o
        olho pega ali. `destaque` (D-297) é o que tinge rótulo e valor.
      */
      ...(api === null ? { destaque: "perigo" as const } : {}),
      tom: api === null ? "perigo" : "ok",
    },
    {
      label: "Migrations aplicadas",
      formula: "Contagem e versão da última migration aplicada, lida do próprio banco.",
      value: first === undefined ? "—" : formatCount(first.db_migrations_count),
      previous: null,
      ...(first === undefined
        ? {}
        : { ressalva: `${first.db_migration_version} · ${formatDateTime(first.db_migration_applied_at)}` }),
      tom: "neutro",
    },
  ];

  /*
    A faixa DENTRO do painel (o CSS já a trata: perde a moldura e fica só com
    o fio de topo). Total e partes, do mesmo array — e "Sem cadência" é grande
    aqui de propósito: job movido por evento não recebe selo, e isso é a
    maioria deles.
  */
  const jobCells: KpiCellData[] = [
    {
      label: "Jobs observados",
      formula: "Um por tipo de job com execução registrada. É o mesmo conjunto da tabela abaixo.",
      value: formatCount(jobs.length),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Em dia",
      formula: "Última execução dentro de 2 ciclos da cadência do job.",
      value: quantos("ok"),
      previous: null,
      tom: "ok",
    },
    {
      label: "Atrasando",
      formula: "Última execução entre 2 e 4 ciclos atrás.",
      value: quantos("atencao"),
      previous: null,
      tom: "atencao",
    },
    {
      label: "Parados",
      formula: "Última execução há mais de 4 ciclos da cadência.",
      value: quantos("critico"),
      previous: null,
      tom: "perigo",
    },
    {
      label: "Nunca rodaram",
      formula: "Tipo de job sem nenhuma execução registrada.",
      value: quantos("nunca"),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Sem cadência",
      formula: "Job movido por evento (webhook, chave suja, backfill): não recebe selo, e a idade crua é o honesto.",
      value: quantos("sem_cadencia"),
      previous: null,
      tom: "neutro",
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / CONFIABILIDADE"
        title="Saúde do Sistema"
        subtitle="O que está no ar, medido no ar. Nenhum número desta tela vem de documentação: o commit sai do /health da API e das variáveis de build, a migration sai do próprio banco, e os jobs saem do registro do que aconteceu — não do que foi agendado."
        /*
          A AÇÃO DO FRAME É "Ver incidentes", e o rótulo mudou porque a entidade
          não existe (D-309): zero tabelas, colunas ou RPCs de incidente,
          uptime, SLA ou indisponibilidade no esquema inteiro. "Incidente"
          promete abertura, dono e fechamento; o que esta casa tem são famílias
          de execuções agrupadas por assinatura de motivo (D-291).

          O link leva o NOME DO PAINEL que ele abre, palavra por palavra, e
          não carrega contagem: um número aqui obrigaria esta tela a uma
          terceira leitura só para enfeitar o rótulo — e com janela de 7 dias
          brigando com a coluna "Falhas 24h" que a tabela abaixo já imprime.
        */
        aside={<Link href="/sincronizacao">Execuções que falharam →</Link>}
      />

      {healthResult.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível ler a saúde do banco: {sanitizeErrorText(healthResult.error.message)}
        </p>
      )}

      <KpiStrip ancora cells={ambiente} />

      <div className="sb-note" style={{ margin: "var(--sb-space-3) 0" }}>
        <span>COMO LER O CÓDIGO NO AR</span>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", lineHeight: 1.6 }}>
          <strong>OUTDATED</strong> significa que a web e a API estão em commits diferentes — normal por alguns
          minutos durante um deploy, e sinal de drift se persistir. <strong>UNKNOWN</strong> nunca é lido como
          “tudo certo”: é a tela dizendo que não conseguiu medir, e por quê.
        </p>
        {/*
          O QUE O TEMPO DA API NÃO DIZ (D-309). O `/health` devolve um objeto
          literal: não consulta o banco, não autentica e não toca nenhuma rota
          de negócio. Uma ida rápida prova que o processo está de pé e
          alcançável — nada além disso. Sem esta frase, o número convida à
          leitura que ele não sustenta, e foi por não a ter que os "42 ms" do
          frame não entraram como cartão.
        */}
        {/*
          A SIGLA "SLA" NÃO ENTRA, nem para ser negada (D-309): `e2e/saude.spec.ts`
          proíbe a palavra nesta tela desde a primeira fatia, e a tentação de
          abrir exceção para uma negação é exatamente como a proibição morreria.
          "compromisso de tempo de resposta" diz o mesmo e não gasta a guarda.
        */}
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", lineHeight: 1.6 }}>
          O tempo ao lado de <strong>API</strong> é o desta ida ao <code>/health</code>, uma amostra só — não é
          média nem compromisso de tempo de resposta. E o <code>/health</code> responde sem consultar o banco:
          rápido ali significa “o processo está de pé”, não “o sistema está saudável”.
        </p>
      </div>

      <Panel
        title="Jobs agendados"
        subtitle="De job_runs: o que rodou de verdade. Um job que sumiu do agendador e um que falha em silêncio aparecem igual aqui, e o veredito é contra a cadência de CADA um — 13h de silêncio é catástrofe num job horário e normal num diário."
      >
        <KpiStrip cells={jobCells} />

        {jobs.length === 0 && healthResult.error === null && (
          <div className="sb-panel-body">
            <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
              Nenhuma execução registrada — o que também é um sinal, não um vazio.
            </p>
          </div>
        )}

        {jobs.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="sb-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Último estado</th>
                  <th>Quando</th>
                  <th>Frescor</th>
                  <th className="sb-num">Idade (h)</th>
                  <th className="sb-num">Falhas 24h</th>
                </tr>
              </thead>
              <tbody>
                {vereditos.map(({ job, veredito }) => {
                  const tom = JOB_VERDICT_TONE[veredito];

                  return (
                    <tr key={job.job_type ?? ""}>
                      <td className="sb-mono">{job.job_type}</td>
                      {/*
                        `runStatusLabel` e não o valor cru: a coluna mostrava
                        "done", em inglês e minúsculo. Mesma classe do rótulo
                        que faltava em D-273, na tela vizinha (D-274).
                      */}
                      <td style={{ color: job.job_status === "failed" ? "var(--sb-danger)" : undefined }}>
                        {job.job_status === null ? "—" : runStatusLabel(job.job_status)}
                      </td>
                      <td>{job.job_last_run_at === null ? "—" : formatDateTime(job.job_last_run_at)}</td>
                      <td>{tom === null ? "—" : <StatePill tone={tom} />}</td>
                      <td className="sb-num">{job.job_age_hours ?? "—"}</td>
                      <td
                        className="sb-num"
                        style={{ color: job.job_failures_24h > 0 ? "var(--sb-danger)" : undefined }}
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
      </Panel>

      {/*
        OS SEIS CARTÕES DE SERVIÇO DO FRAME CONTINUAM FORA, e a recusa foi
        REMEDIDA em D-309 — a pergunta de D-282 aplicada a este registro: *ele
        ainda é verdade, ou a fonte que ele nega já nasceu?* Desde D-274 o
        esquema ganhou `metric_refresh_state`, `job_runs.duration_ms` e uma
        varredura inteira de desempenho com `pg_stat_statements`. A resposta,
        cartão a cartão:

        - **"Aplicação Web · 42 ms"**: zero cronômetro em `apps/web` (nenhum
          `performance.now`, nenhum `instrumentation.ts`, nenhum web-vitals), e
          o único detalhe honesto — "no ar, commit X" — É a célula âncora, que
          diz mais: CURRENT/OUTDATED/UNKNOWN com o motivo;
        - **"API Mercado Livre · 186 ms"**: o cliente HTTP do ML não se
          cronometra, e `job_runs.duration_ms` é a janela do handler inteiro,
          com o backoff de até 30 s DENTRO dela — um 429 entraria como
          "latência". O número que existe mede a ida até a api DESTA casa, e
          está onde ele é verdade: na ressalva da célula "API";
        - **"Workers · 3 filas em retry"**: fila não existe no Postgres (o nome
          dela morre no enfileiramento) e "em retry" é presente do verbo —
          `job_runs` só guarda execução encerrada. O estado vivo mora no Cloud
          Tasks, e perguntar a ele é a permissão de nuvem que D-176 excluiu;
        - **"Banco · 12 ms"**: `pg_stat_statements` está instalado e povoado, e
          é ele que prova a impossibilidade: no mesmo instante ele sustenta
          0,268 ms, 0,540 ms, 45,5 ms e 122,2 ms — 456× de distância. "12 ms"
          não seria uma medição, seria a escolha de um agregado;
        - **"Armazenamento · 2,4 TB livres"**: `documents` conta XML, mas
          ninguém guarda bytes, e "livres" é cota do provedor — a mesma
          permissão excluída;
        - **"Fila de Atendimento · Estável"**: a profundidade tem fonte
          (`support_cases.internal_status`), mas "estável" é veredito sem
          limiar — não há meta de fila no esquema —, e a fila tem tela dona
          (D-224).

        A faixa navy com "99,97% de uptime" segue sem fonte: zero tabelas,
        views ou colunas de incidente, uptime, SLA ou indisponibilidade.
        Derivá-la do heartbeat seria pior — `system.ping` diz que o worker
        rodou, não que o produto estava disponível para quem usa.
      */}
    </Shell>
  );
}
