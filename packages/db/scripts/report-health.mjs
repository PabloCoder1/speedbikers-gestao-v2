/**
 * Relatório de saúde sobre o que JÁ EXISTE — sem plataforma nova.
 *
 * O item do P1 pedia "relatório de performance sobre `job_runs`, `sync_runs`,
 * `/saude`, sem criar plataforma nova". Este script é o relatório: nenhuma
 * tabela, nenhuma view, nenhum endpoint. Só consultas sobre o que o sistema já
 * grava, reunidas num lugar e **com as armadilhas de leitura embutidas**.
 *
 * ⚠️ POR QUE AS ARMADILHAS VÊM JUNTO. Esta sessão errou a leitura destes
 * mesmos números seis vezes, e cada erro está registrado numa decisão. Um
 * relatório que apresentasse os números crus repetiria os seis. As frases de
 * alerta abaixo não são enfeite: são o que separa o número do engano.
 *
 *   1. Percentagem sem o total infla em banco ocioso (D-198/D-199).
 *   2. `job_runs.attempt` é constante em 1: conte `job_id` repetido (D-201).
 *   3. `n_live_tup` é estimativa e já errou por 45x (D-182).
 *   4. `stats_reset` de `pg_stat_database` é NULO mesmo depois de um restart;
 *      quem sabe a verdade é `pg_stat_statements_info` (D-198, corrigido aqui).
 *   5. `seq_scan` alto em `job_runs` é quem investiga, não a aplicação (D-198).
 *   6. "80% de falha" pode ser um crawl com limite de taxa que progride, ou um
 *      status estruturalmente "partial" que entrega 100% (D-203).
 *
 * Como rodar:
 *
 *   # contra o Supabase local
 *   eval "$(pnpm exec supabase status -o env)"
 *   DB_URL="$DB_URL" pnpm --filter @sb/db run report:health
 *
 *   # contra o Dev (precisa da senha do banco)
 *   DB_URL="postgresql://postgres:SENHA@db.<ref>.supabase.co:5432/postgres" \
 *     pnpm --filter @sb/db run report:health
 *
 * Só faz SELECT. Não escreve, não altera, não cria nada.
 */
import { Client } from "pg";

const DB_URL = process.env.DB_URL;

if (DB_URL == null) {
  console.error("falta DB_URL no ambiente");
  console.error('local: eval "$(pnpm exec supabase status -o env)"');
  process.exit(1);
}

const DIAS = Number(process.env.REPORT_DIAS ?? 7);

const client = new Client({ connectionString: DB_URL });

function titulo(texto) {
  console.log(`\n${"=".repeat(72)}\n${texto}\n${"=".repeat(72)}`);
}

function nota(texto) {
  console.log(`   ⚠️  ${texto}`);
}

function linha(rotulo, valor) {
  console.log(`   ${rotulo.padEnd(42, ".")} ${valor}`);
}

async function uma(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] ?? {};
}

async function todas(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}

/**
 * A JANELA vem primeiro porque TUDO depende dela.
 *
 * `pg_stat_database.stats_reset` mente por omissão: fica NULO mesmo quando um
 * restart levou as estatísticas junto. Quem tem a verdade é
 * `pg_stat_statements_info.stats_reset` — e a validação contra `count(*)` da
 * própria `job_runs` prova qual das duas acreditar.
 */
async function janela() {
  titulo("1. JANELA DAS ESTATÍSTICAS — leia isto antes de qualquer número");

  const r = await uma(`
    select (select stats_reset from pg_stat_database where datname = current_database()) as reset_enganoso,
           (select stats_reset from pg_stat_statements_info)                             as reset_real,
           pg_postmaster_start_time()                                                    as restart,
           extract(epoch from (now() - (select stats_reset from pg_stat_statements_info))) as janela_seg,
           (select count(*) from public.job_runs)                                        as job_runs_total,
           (select n_tup_ins from pg_stat_user_tables where relname = 'job_runs')        as job_runs_n_tup_ins,
           (select count(*) from public.job_runs
             where created_at >= (select stats_reset from pg_stat_statements_info))      as job_runs_na_janela
  `);

  const horas = Number(r.janela_seg) / 3600;

  linha("pg_stat_database.stats_reset", r.reset_enganoso ?? "NULO  ← não acredite");
  linha("pg_stat_statements_info.stats_reset", r.reset_real);
  linha("último restart do Postgres", r.restart);
  linha("JANELA REAL", `${horas.toFixed(1)} h`);
  console.log();
  linha("job_runs, linhas de verdade", r.job_runs_total);
  linha("job_runs, n_tup_ins (só a janela)", r.job_runs_n_tup_ins);
  linha("job_runs criadas dentro da janela", r.job_runs_na_janela);

  const bate = Math.abs(Number(r.job_runs_n_tup_ins) - Number(r.job_runs_na_janela)) <= 5;

  if (bate) {
    nota(
      `n_tup_ins bate com count(*) DENTRO da janela, e não com o total — ` +
        `confirmado que as estatísticas cobrem ${horas.toFixed(1)} h, não a vida da tabela.`,
    );
  } else {
    nota("n_tup_ins NÃO bate com a janela: investigue antes de usar qualquer taxa daqui.");
  }

  nota("Toda percentagem abaixo tem esta janela como denominador implícito.");

  return { horas, janelaSeg: Number(r.janela_seg) };
}

/** A fila: vazão, desperdício e reentrega — as três lidas do jeito certo. */
async function fila() {
  titulo(`2. FILA (job_runs) — últimos ${DIAS} dias`);

  const webhook = await todas(
    `
    select split_part(split_part(dedupe_key, ':', 2), '/', 2)              as recurso,
           count(*)                                                        as execucoes,
           count(*) filter (where coalesce(processed, 0) > 0)              as com_trabalho,
           count(*) filter (where status = 'failed')                       as falhas,
           round(sum(duration_ms) / 1000.0)                                as segundos
      from public.job_runs
     where created_at >= now() - ($1 || ' days')::interval
       and job_type = 'sync.webhook.received'
     group by 1 order by execucoes desc
  `,
    [DIAS],
  );

  const semConsumidor = webhook.filter((w) => Number(w.com_trabalho) === 0);
  const execDesperdicio = semConsumidor.reduce((s, w) => s + Number(w.execucoes), 0);
  const segDesperdicio = semConsumidor.reduce((s, w) => s + Number(w.segundos), 0);

  const total = await uma(
    `select count(*) as n from public.job_runs where created_at >= now() - ($1 || ' days')::interval`,
    [DIAS],
  );

  const pct = (100 * execDesperdicio) / Math.max(Number(total.n), 1);

  linha("execuções na fila inteira", total.n);
  linha("webhook SEM consumidor (D-179)", `${execDesperdicio}  (${pct.toFixed(1)}% da fila)`);
  linha("...e o que isso custa de worker", `${segDesperdicio} s em ${DIAS} dias`);

  nota(
    "O par é o ponto: o desperdício é enorme em CONTAGEM e desprezível em TEMPO. " +
      "Ele não queima CPU — queima um dispatch, uma invocação e uma linha por evento.",
  );

  const comConsumidor = webhook.filter((w) => Number(w.com_trabalho) > 0);

  for (const w of comConsumidor) {
    const noop = Number(w.execucoes) - Number(w.com_trabalho) - Number(w.falhas);
    linha(`  tópico ${w.recurso}`, `${w.execucoes} exec, ${w.com_trabalho} com trabalho, ${noop} no-op`);
  }

  nota(
    "No-op de tópico COM consumidor é filtro de domínio, não desperdício — " +
      "somá-lo ao número acima proporia desligar um consumidor que funciona.",
  );

  const retry = await uma(
    `
    select max(attempt)                              as maior_attempt,
           count(*) filter (where attempt > 1)       as linhas_attempt_maior_1,
           count(*)                                  as execucoes,
           count(distinct job_id)                    as jobs,
           count(*) - count(distinct job_id)         as execucoes_extras
      from public.job_runs
     where created_at >= now() - ($1 || ' days')::interval
  `,
    [DIAS],
  );

  console.log();
  linha("maior job_runs.attempt", retry.maior_attempt);
  linha("linhas com attempt > 1", retry.linhas_attempt_maior_1);
  linha("REENTREGAS REAIS (job_id repetido)", retry.execucoes_extras);

  if (Number(retry.linhas_attempt_maior_1) === 0 && Number(retry.execucoes_extras) > 0) {
    nota(
      "O instrumento diz ZERO retentativa enquanto " +
        `${retry.execucoes_extras} aconteceram. \`attempt\` viaja no CORPO do job, que o ` +
        "Cloud Tasks reentrega idêntico (D-201). Corrigido em D-202 — sem efeito até o deploy.",
    );
  }
}

/** Sincronização: o número que importa é FRESCOR, não taxa de sucesso. */
async function sincronizacao() {
  titulo(`3. SINCRONIZAÇÃO (sync_runs) — frescor por recurso`);

  const frescor = await todas(`
    select r.resource,
           count(*) filter (where r.status = 'done')                        as ok,
           count(*) filter (where r.status = 'partial')                     as parcial,
           count(*) filter (where r.status = 'failed')                      as falhou,
           round(extract(epoch from (now() - max(r.finished_at)
             filter (where r.status in ('done', 'partial')))) / 3600.0, 1)  as h_desde_o_ultimo_sucesso
      from public.sync_runs r
     where r.started_at >= now() - interval '7 days'
     group by r.resource
     order by h_desde_o_ultimo_sucesso desc nulls first
  `);

  if (frescor.length === 0) {
    linha("(nenhuma sincronização na janela)", "banco sem tráfego, ou recém-recriado");
  }

  for (const f of frescor) {
    const idade = f.h_desde_o_ultimo_sucesso === null ? "NUNCA" : `${f.h_desde_o_ultimo_sucesso} h atrás`;
    linha(f.resource, `${idade}   (ok ${f.ok} / parcial ${f.parcial} / falhou ${f.falhou})`);
  }

  nota(
    "FRESCOR manda, não taxa de sucesso: um recurso que falha metade das vezes e " +
      "sincronizou há uma hora está melhor que um que 'passa' e não sincroniza há três dias.",
  );
  nota(
    "'partial' pode ser condição PERMANENTE e inofensiva — o Full fica 100% partial " +
      "por itens que sumiram do ML, e ainda assim entrega 100% dos buckets (D-203).",
  );
}

/** O banco: ocupação absoluta antes de qualquer percentagem. */
async function banco({ janelaSeg }) {
  titulo("4. BANCO — ocupação, e só depois os maiores consumidores");

  const ocupacao = await uma(`select sum(total_exec_time) as ms from pg_stat_statements`);
  const segCpu = Number(ocupacao.ms) / 1000;
  const pctRelogio = (100 * segCpu) / Math.max(janelaSeg, 1);

  linha("relógio decorrido na janela", `${(janelaSeg / 3600).toFixed(1)} h`);
  linha("CPU de consulta somada", `${segCpu.toFixed(0)} s`);
  linha("OCUPAÇÃO", `${pctRelogio.toFixed(2)}% de um núcleo`);

  nota(
    `Guarde este número. Abaixo, "X% do banco" significa X% de ${segCpu.toFixed(0)} s — ` +
      "e num banco ocioso toda participação percentual infla sem querer dizer nada.",
  );

  const topo = await todas(`
    with t as (select sum(total_exec_time) as ms_todos from pg_stat_statements)
    select left(regexp_replace(s.query, '\\s+', ' ', 'g'), 58)          as consulta,
           round((s.total_exec_time / 1000)::numeric, 1)                as seg,
           round((s.total_exec_time / t.ms_todos * 100)::numeric, 1)    as pct_do_banco,
           s.calls
      from pg_stat_statements s, t
     order by s.total_exec_time desc
     limit 6
  `);

  console.log();

  for (const c of topo) {
    const pctRel = (100 * Number(c.seg)) / Math.max(janelaSeg, 1);
    console.log(
      `   ${String(c.seg).padStart(7)} s  ${String(c.pct_do_banco).padStart(5)}% do banco  ` +
        `${pctRel.toFixed(3).padStart(6)}% do relógio  ${c.consulta}`,
    );
  }

  nota(
    "As DUAS percentagens vêm juntas de propósito: a primeira ordena, a segunda decide. " +
      "Um consumidor com 45% do banco e 0,7% do relógio não é problema (D-198).",
  );
}

/** Frescor do dado que a tela mostra — "o que estou vendo é de quando?". */
async function frescorDoDado() {
  titulo("5. FRESCOR DO DADO — o que a tela mostra é de quando?");

  const fontes = await todas(`
    select 'Full (buckets na janela de 3 dias)' as fonte,
           count(*)                                                                  as linhas,
           count(*) filter (where u.ultima < now() - interval '3 days')               as fora_da_janela,
           round(extract(epoch from (now() - max(u.ultima))) / 3600.0, 1)             as h_do_mais_novo,
           round(extract(epoch from (now() - min(u.ultima))) / 3600.0, 1)             as h_do_mais_velho
      from (select ml_account_id, inventory_id, max(captured_at) as ultima
              from public.fulfillment_stock_snapshots
             group by 1, 2) u
    union all
    select 'Visitas de anúncio', count(*), 0,
           round(extract(epoch from (now() - max(synced_at))) / 3600.0, 1),
           round(extract(epoch from (now() - min(synced_at))) / 3600.0, 1)
      from public.daily_listing_visits where synced_at >= now() - interval '7 days'
    union all
    select 'Anúncios', count(*), 0,
           round(extract(epoch from (now() - max(updated_at))) / 3600.0, 1),
           round(extract(epoch from (now() - min(updated_at))) / 3600.0, 1)
      from public.listings
    union all
    select 'Pedidos', count(*), 0,
           round(extract(epoch from (now() - max(updated_at))) / 3600.0, 1), null
      from public.orders where updated_at >= now() - interval '7 days'
  `);

  for (const f of fontes) {
    if (f.h_do_mais_novo === null) {
      // Sem linha nenhuma na janela. Dizer "null h" seria pior que dizer nada:
      // parece medição e não é.
      linha(f.fonte, "sem dado na janela");
      continue;
    }

    const fora = Number(f.fora_da_janela) > 0 ? `  ⚠️ ${f.fora_da_janela} FORA da janela` : "";
    linha(f.fonte, `mais novo ${f.h_do_mais_novo} h${fora}`);
  }

  nota(
    "Full tem janela de frescor de 3 dias (D-173/D-204): bucket fora dela some do saldo, " +
      "e some em silêncio. É a linha para olhar antes de confiar no número do Full.",
  );
}

async function main() {
  await client.connect();

  try {
    console.log(`\nRelatório de saúde — ${new Date().toISOString()}`);
    console.log("Só leitura. Nenhuma tabela, view ou endpoint foi criado para isto.");

    const { janelaSeg } = await janela();
    await fila();
    await sincronizacao();
    await banco({ janelaSeg });
    await frescorDoDado();

    console.log(
      "\nFim. Os alertas com ⚠️ são as seis armadilhas de leitura documentadas " +
        "em docs/PERFORMANCE.md — leia-os junto dos números, não depois.\n",
    );
  } finally {
    await client.end();
  }
}

await main();
