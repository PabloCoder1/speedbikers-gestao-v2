/**
 * Onde vai o tempo de uma ida ao banco: PostgREST ou o round trip?
 *
 * A pergunta que este script responde foi registrada no P1 da trilha 8B:
 * valeria trocar o caminho quente do worker de PostgREST para uma conexão
 * Postgres direta (pooler)? A hipótese era que os ~50-90 ms por chamada
 * fossem PostgREST, e que trocá-lo derrubaria o número para ~5 ms.
 *
 * O script mede a MESMA leitura por três caminhos, no MESMO processo, contra
 * o MESMO Postgres local:
 *
 *   1. Postgres direto (`pg`, porta 54322)
 *   2. PostgREST com a consulta real (porta 54321)
 *   3. HTTP até a mesma porta SEM tocar no Postgres — uma tabela inexistente,
 *      que o PostgREST recusa pelo schema cache (PGRST205). É o controle: o
 *      piso de "fazer um HTTP até aqui".
 *
 * (2) − (3) isola o que o PostgREST faz de trabalho: parse do querystring,
 * montagem do SQL, serialização JSON.
 *
 * ⚠️ O que este script NÃO mede: a rede de produção (Cloud Run → Supabase).
 * O piso local é o proxy de rede do Docker Desktop mais o Kong, e não se
 * parece com o de produção. O que é transferível é a DECOMPOSIÇÃO — quanto
 * do custo é processamento do PostgREST — porque essa parcela não depende da
 * rede.
 *
 * Como rodar (com o Supabase local de pé):
 *
 *   eval "$(pnpm exec supabase status -o env)"
 *   DB_URL="$DB_URL" API_URL="$API_URL" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     pnpm --filter @sb/db run bench:postgrest
 */
import { Client } from "pg";

const DB_URL = process.env.DB_URL;
const API_URL = process.env.API_URL;
const KEY = process.env.SERVICE_ROLE_KEY;

if (DB_URL == null || API_URL == null || KEY == null) {
  console.error("faltam DB_URL / API_URL / SERVICE_ROLE_KEY no ambiente");
  console.error('rode antes: eval "$(pnpm exec supabase status -o env)"');
  process.exit(1);
}

const N = Number(process.env.BENCH_N ?? 300);
const AQUECIMENTO = 30;

function estatisticas(amostras) {
  const ordenadas = [...amostras].sort((a, b) => a - b);
  const pos = (p) => ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * p))];
  const soma = ordenadas.reduce((acc, v) => acc + v, 0);

  return {
    n: ordenadas.length,
    media: soma / ordenadas.length,
    p50: pos(0.5),
    p95: pos(0.95),
    min: ordenadas[0],
  };
}

function linha(nome, e) {
  const f = (v) => v.toFixed(3).padStart(8);
  console.log(`${nome.padEnd(36)} n=${String(e.n).padStart(4)}  média=${f(e.media)}  p50=${f(e.p50)}  p95=${f(e.p95)}  mín=${f(e.min)}`);
}

// A leitura de `resolveSku` (persist-order.ts) — a mais representativa do
// caminho quente. Sem linha correspondente: o que se mede é o CAMINHO, não a
// varredura.
const SQL = `select id, sku_id from public.sku_listing_links
             where ml_account_id = $1 and ref_kind = 'ITEM' and item_id = $2 and variation_id is null
             limit 1`;
const CONTA = "00000000-0000-4000-8000-0000000000ff";
const ITEM = "MLB0000000000";

const CABECALHOS = { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" };
const REST =
  `${API_URL}/rest/v1/sku_listing_links?select=id,sku_id` +
  `&ml_account_id=eq.${CONTA}&ref_kind=eq.ITEM&item_id=eq.${ITEM}&variation_id=is.null&limit=1`;
const REST_SEM_SQL = `${API_URL}/rest/v1/tabela_inexistente_para_o_controle?select=id&limit=1`;

const client = new Client({ connectionString: DB_URL });
await client.connect();

async function medir(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

const direta = () => medir(() => client.query(SQL, [CONTA, ITEM]));
const rest = () => medir(async () => {
  const r = await fetch(REST, { headers: CABECALHOS });
  await r.arrayBuffer();
});
const semSql = () => medir(async () => {
  const r = await fetch(REST_SEM_SQL, { headers: CABECALHOS });
  await r.arrayBuffer();
});

for (let i = 0; i < AQUECIMENTO; i += 1) {
  await direta();
  await rest();
  await semSql();
}

// Alternado: qualquer variação da máquina cai nos três lados.
const amostras = { direta: [], rest: [], semSql: [] };
for (let i = 0; i < N; i += 1) {
  amostras.direta.push(await direta());
  amostras.rest.push(await rest());
  amostras.semSql.push(await semSql());
}

const eDireta = estatisticas(amostras.direta);
const eRest = estatisticas(amostras.rest);
const eSemSql = estatisticas(amostras.semSql);

console.log("");
console.log("Mesma leitura, mesmo Postgres local, mesmo processo (ms):");
console.log("");
linha("Postgres direto (pg, 54322)", eDireta);
linha("PostgREST com a consulta (54321)", eRest);
linha("HTTP sem SQL — controle (PGRST205)", eSemSql);
console.log("");
console.log(`  piso de um HTTP até a porta (p50):      ${eSemSql.p50.toFixed(3)} ms`);
console.log(`  o que o PostgREST soma sobre o piso:    ${(eRest.p50 - eSemSql.p50).toFixed(3)} ms`);
console.log(`  o que o Postgres direto custa:          ${eDireta.p50.toFixed(3)} ms`);
console.log("");
console.log("  Se o segundo número for pequeno, o custo por chamada é o");
console.log("  ROUND TRIP, não o PostgREST — e a alavanca é fazer menos");
console.log("  chamadas, não trocar de protocolo.");

await client.end();
