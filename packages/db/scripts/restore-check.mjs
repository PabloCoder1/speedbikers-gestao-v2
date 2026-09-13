/**
 * ENSAIO DE RESTORE — o dado VOLTA? (D-332)
 *
 * O Supabase do Dev tem backup físico diário (medido em 2026-09-13: oito
 * listados, ~7 dias de retenção). Backup que nunca foi restaurado é hipótese.
 * Este script compara um projeto RESTAURADO a partir de um desses backups com o
 * Dev, e diz com PASS/FAIL o que prova e o que não prova.
 *
 * ⚠️ POR QUE NÃO É UMA COMPARAÇÃO INGÊNUA. O backup é um instante congelado; o Dev
 * continua andando (~221 webhooks por hora). Contar linhas nos dois lados
 * "falharia" sempre e não provaria nada. Por isso, três camadas:
 *
 *   1. **Tabelas append-only** (têm gatilho que recusa UPDATE/DELETE): contar
 *      `<coluna de inserção> <= BACKUP_AT` nos DOIS lados tem de dar EXATAMENTE
 *      igual. É a prova forte — o que já existia no instante do backup não pode
 *      ter sumido nem sobrado.
 *   2. **Invariantes DENTRO do restaurado**, sem olhar o Dev: RLS ligada em toda
 *      tabela de `public`, e o ledger de estoque batendo com a projeção
 *      (`compute_inventory_balances_from_ledger` × `inventory_balances`, a mesma
 *      régua do job `verify-ledger-integrity`).
 *   3. **Tabelas que mudam pouco** (catálogo, membros, contas): a diferença sai
 *      como INFO — é o Dev andando, não defeito.
 *
 * Quatro tabelas append-only NÃO têm `created_at` e usam a coluna do fato
 * (`occurred_at`, `changed_at`, `requested_at`), que pode ser retroativa: uma
 * linha inserida DEPOIS do backup com data antiga faz o Dev contar a mais sem
 * nada estar errado. Elas saem como comparação APROXIMADA — Dev ≥ restaurado é
 * aceito; o restaurado com MAIS linhas que o Dev é que seria defeito.
 *
 * Como rodar (as URLs são SUAS, com a senha de cada banco; o script nunca as
 * imprime):
 *
 *   DEV_DB_URL="postgresql://postgres:SENHA@db.<ref-dev>.supabase.co:5432/postgres" \
 *   RESTORED_DB_URL="postgresql://postgres:SENHA@db.<ref-restaurado>.supabase.co:5432/postgres" \
 *   BACKUP_AT="2026-09-13T05:59:13Z" \
 *     pnpm --filter @sb/db run check:restore
 *
 * `BACKUP_AT` é o instante do backup escolhido, como o Dashboard mostra na aba
 * "Scheduled backups" (em UTC).
 *
 * Só lê. As duas sessões abrem em `READ ONLY`: um UPDATE por engano aqui dentro
 * seria recusado pelo próprio Postgres, não por disciplina.
 */
import { Client } from "pg";

const DEV_DB_URL = process.env.DEV_DB_URL;
const RESTORED_DB_URL = process.env.RESTORED_DB_URL;
const BACKUP_AT = process.env.BACKUP_AT;

if (!DEV_DB_URL || !RESTORED_DB_URL || !BACKUP_AT) {
  console.error("faltam DEV_DB_URL, RESTORED_DB_URL e BACKUP_AT no ambiente (ver o cabeçalho do script)");
  process.exit(2);
}

if (Number.isNaN(Date.parse(BACKUP_AT))) {
  console.error(`BACKUP_AT não é um instante válido: ${BACKUP_AT}`);
  process.exit(2);
}

/**
 * As append-only, com a coluna de inserção. Medido no catálogo em 2026-09-13
 * (gatilhos `*_reject_mutation` e `guard_support_reply_attempts`). `exata` é
 * quando a coluna é o carimbo da INSERÇÃO; `false` quando é a data do fato.
 */
const APPEND_ONLY = [
  { tabela: "domain_events", coluna: "created_at", exata: true },
  { tabela: "job_runs", coluna: "created_at", exata: true },
  { tabela: "organization_access_events", coluna: "created_at", exata: true },
  { tabela: "sku_listing_link_events", coluna: "created_at", exata: true },
  { tabela: "stock_movements", coluna: "created_at", exata: true },
  { tabela: "support_case_events", coluna: "created_at", exata: true },
  { tabela: "sync_errors", coluna: "created_at", exata: true },
  { tabela: "sync_runs", coluna: "created_at", exata: true },
  { tabela: "listing_relist_events", coluna: "occurred_at", exata: false },
  { tabela: "purchase_order_events", coluna: "occurred_at", exata: false },
  { tabela: "sku_cost_history", coluna: "changed_at", exata: false },
  { tabela: "support_reply_attempts", coluna: "requested_at", exata: false },
];

/** Mudam pouco: a diferença é informação, não reprovação. */
const POUCA_MUDANCA = [
  "organizations",
  "organization_members",
  "ml_accounts",
  "skus",
  "suppliers",
  "purchase_orders",
  "documents",
  "listings",
  "orders",
];

const resultados = [];

function registrar(nivel, rotulo, detalhe) {
  resultados.push({ nivel, rotulo, detalhe });
  console.log(`${nivel.padEnd(4)} ${rotulo}${detalhe === undefined ? "" : ` — ${detalhe}`}`);
}

async function conectar(url) {
  const client = new Client({ connectionString: url, statement_timeout: 120_000 });

  await client.connect();
  await client.query("set session characteristics as transaction read only");

  return client;
}

async function contar(client, sql, params = []) {
  const { rows } = await client.query(sql, params);

  return Number(rows[0]?.n ?? 0);
}

/**
 * Uma seção que QUEBRA vira FAIL, e o script segue. Sem isso, um restaurado
 * incompleto — sem um schema, sem uma tabela — derrubava o processo sem veredito
 * nenhum, e esse é justamente o caso que o ensaio existe para pegar.
 */
async function secao(rotulo, corpo) {
  try {
    await corpo();
  } catch (erro) {
    registrar("FAIL", rotulo, `a seção quebrou: ${String(erro.message).split("\n")[0]}`);
  }
}

const dev = await conectar(DEV_DB_URL);
const restaurado = await conectar(RESTORED_DB_URL);

try {
  console.log(`instante do backup: ${new Date(BACKUP_AT).toISOString()}\n`);

  // ------------------------------------------------------------ 1. migrations
  console.log("== migrations");
  await secao("migrations", async () => {
    const versoes = async (client) =>
      new Set((await client.query("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version));
    const vDev = await versoes(dev);
    const vRest = await versoes(restaurado);
    const soNoRestaurado = [...vRest].filter((v) => !vDev.has(v));
    const soNoDev = [...vDev].filter((v) => !vRest.has(v)).sort();

    registrar(
      soNoRestaurado.length === 0 && vRest.size > 0 ? "PASS" : "FAIL",
      "toda migration do restaurado existe no Dev",
      `restaurado ${String(vRest.size)}, Dev ${String(vDev.size)}${soNoRestaurado.length > 0 ? `, só no restaurado: ${soNoRestaurado.join(",")}` : ""}`,
    );

    if (soNoDev.length > 0) {
      registrar("INFO", "migrations aplicadas no Dev depois do backup", soNoDev.join(", "));
    }
  });

  // ------------------------------------------------------------- 2. RLS
  console.log("\n== RLS no restaurado");
  await secao("RLS", async () => {
    const semRls = await restaurado.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by c.relname`,
    );
    const totalTabelas = await contar(
      restaurado,
      `select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`,
    );

    registrar(
      semRls.rows.length === 0 && totalTabelas > 0 ? "PASS" : "FAIL",
      "RLS ligada em toda tabela de public",
      semRls.rows.length === 0
        ? `${String(totalTabelas)} tabelas`
        : `${String(totalTabelas)} tabelas; sem RLS: ${semRls.rows.map((r) => r.relname).join(", ")}`,
    );
  });

  // ----------------------------------------------------- 3. append-only
  console.log("\n== append-only até o instante do backup");

  for (const { tabela, coluna, exata } of APPEND_ONLY) {
    const sql = `select count(*) as n from public.${tabela} where ${coluna} <= $1`;
    let nDev;
    let nRest;

    try {
      nDev = await contar(dev, sql, [BACKUP_AT]);
      nRest = await contar(restaurado, sql, [BACKUP_AT]);
    } catch (erro) {
      registrar("FAIL", `${tabela}`, `não foi possível contar: ${erro.message.split("\n")[0]}`);
      continue;
    }

    if (exata) {
      registrar(nDev === nRest ? "PASS" : "FAIL", `${tabela} (${coluna})`, `Dev ${String(nDev)}, restaurado ${String(nRest)}`);
    } else {
      // Coluna do fato, que pode ser retroativa: Dev ≥ restaurado é aceito.
      registrar(
        nRest <= nDev ? "PASS" : "FAIL",
        `${tabela} (${coluna}, aproximada)`,
        `Dev ${String(nDev)}, restaurado ${String(nRest)}${nDev > nRest ? " — Dev a mais é linha retroativa, aceito" : ""}`,
      );
    }
  }

  await secao("auth.users", async () => {
    const sqlAuth = "select count(*) as n from auth.users where created_at <= $1";
    const authDev = await contar(dev, sqlAuth, [BACKUP_AT]);
    const authRest = await contar(restaurado, sqlAuth, [BACKUP_AT]);

    // Usuário pode ser APAGADO no Dev depois do backup; o restaurado a mais é aceito.
    registrar(
      authRest >= authDev ? "PASS" : "FAIL",
      "auth.users criados até o backup",
      `Dev ${String(authDev)}, restaurado ${String(authRest)}${authRest > authDev ? " — usuário removido do Dev depois do backup" : ""}`,
    );
  });

  // ------------------------------------------- 4. ledger × projeção no restaurado
  console.log("\n== ledger × projeção de estoque, dentro do restaurado");
  await secao("ledger × projeção", async () => {
    const organizacoes = await restaurado.query("select id from public.organizations order by id");
    let divergenciasTotal = 0;

    for (const { id } of organizacoes.rows) {
      const divergencias = await contar(
        restaurado,
        `with ledger as (
           select sku_id, location_kind, quantity from public.compute_inventory_balances_from_ledger($1)
         ), projecao as (
           select sku_id, location_kind, quantity from public.inventory_balances where organization_id = $1
         )
         select count(*) as n
         from ledger l full outer join projecao p
           on p.sku_id = l.sku_id and p.location_kind = l.location_kind
         where coalesce(l.quantity, 0) <> coalesce(p.quantity, 0)`,
        [id],
      );

      divergenciasTotal += divergencias;
    }

    registrar(
      divergenciasTotal === 0 && organizacoes.rows.length > 0 ? "PASS" : "FAIL",
      "saldo projetado bate com a soma do ledger",
      `${String(organizacoes.rows.length)} organização(ões), ${String(divergenciasTotal)} chave(s) divergente(s)`,
    );
  });

  // ------------------------------------------------------ 5. pouca mudança
  console.log("\n== tabelas que mudam pouco (informação — o Dev anda)");

  for (const tabela of POUCA_MUDANCA) {
    await secao(tabela, async () => {
      const sql = `select count(*) as n from public.${tabela}`;
      const nDev = await contar(dev, sql);
      const nRest = await contar(restaurado, sql);

      registrar("INFO", tabela, `Dev ${String(nDev)}, restaurado ${String(nRest)}, diferença ${String(nDev - nRest)}`);
    });
  }
} finally {
  await dev.end();
  await restaurado.end();
}

const falhas = resultados.filter((r) => r.nivel === "FAIL").length;

console.log(`\n${falhas === 0 ? "RESTORE_OK" : "RESTORE_REPROVADO"} — ${String(resultados.filter((r) => r.nivel === "PASS").length)} PASS, ${String(falhas)} FAIL`);
process.exit(falhas === 0 ? 0 : 1);
