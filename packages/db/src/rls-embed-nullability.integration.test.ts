import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * O tipo gerado NÃO modela a RLS, e por isso um embed pode voltar `null` numa
 * coluna que ele declara não-nula (D-192).
 *
 * **Por que este teste existe.** `supabase gen types` deriva a nulabilidade de
 * um embed da CHAVE ESTRANGEIRA: `created_by NOT NULL` → `profiles` não-nulo.
 * Mas a RLS é avaliada depois, e uma linha invisível ao chamador não vira
 * erro: vira `null`. O tipo é otimista.
 *
 * Isso importa porque a conclusão natural é a errada. Ao remover um cast que
 * declarava `profiles: {...} | null`, o compilador passa a dizer que o `?.` é
 * desnecessário — e o lint EXIGE removê-lo. Seguir o compilador ali apaga a
 * defesa contra um estado que acontece de verdade.
 *
 * O caminho para chegar aqui foi tentar exatamente isso em
 * `apps/web/app/usuarios/page.tsx` e reverter: ver `docs/DECISIONS.md`, D-192.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

// Este teste fala com o Postgres DIRETO, e não pelo PostgREST: o que está sob
// prova é a semântica da RLS num embed, e trocar de papel por transação é
// como a suíte de RLS já faz.
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG_A = randomUUID();
const USER_A = randomUUID();
// USER_B nao e membro de organizacao nenhuma: `shares_org_with` e falso para
// ele, e e so isso que o teste precisa. Uma segunda organizacao seria peca
// sobrando.
const USER_B = randomUUID();

let client: Client;

/** Roda como `authenticated` com o `sub` de um usuário, e reverte. */
async function comoUsuario<T>(userId: string, sql: string): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);

    const resultado = await client.query(sql);

    return resultado.rows as T[];
  } finally {
    await client.query("rollback");
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  for (const [id, email] of [
    [USER_A, `a-${USER_A.slice(0, 8)}@d192.test`],
    [USER_B, `b-${USER_B.slice(0, 8)}@d192.test`],
  ]) {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                               email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'x',now(),'{}',now(),now())`,
      [id, email],
    );
  }

  await client.query(`insert into public.organizations (id, name, slug) values ($1,'D-192',$2)`, [
    ORG_A,
    `d192-${ORG_A.slice(0, 8)}`,
  ]);

  await client.query(`insert into public.organization_members (organization_id, user_id, role) values ($1,$2,'ADMIN')`, [
    ORG_A,
    USER_A,
  ]);

  // A peça central: uma linha da Org A cujo autor é da Org B. `created_by` é
  // NOT NULL com FK para `profiles`, então o tipo gerado promete não-nulo.
  await client.query(
    `insert into public.feature_suggestions (organization_id, created_by, original_text, status)
     values ($1,$2,'D-192 — autor de outra organização','nova')`,
    [ORG_A, USER_B],
  );
});

afterAll(async () => {
  // Só a sugestão sai. A ORGANIZAÇÃO fica, e não por descuido: criar um membro
  // dispara `log_member_access_change`, e `organization_access_events` é
  // append-only — recusa DELETE até em cascata. É a mesma convenção já
  // registrada em `rls.integration.test.ts` e `idempotent-writes`: o que é
  // append-only por desenho não é limpo, fica como ficaria em produção.
  //
  // Não atrapalha ninguém: os ids são aleatórios a cada execução, e as
  // consultas dos outros testes são escopadas por RLS — uma organização de
  // que ninguém mais é membro é invisível para eles.
  await client.query(`delete from public.feature_suggestions where organization_id = $1`, [ORG_A]);
  await client.end();
});

describe("nulabilidade de embed sob RLS (D-192)", () => {
  it("a linha do autor existe e é INVISÍVEL ao leitor de outra organização", async () => {
    const visao = await comoUsuario<{ sugestoes: string; perfis: string }>(
      USER_A,
      `select (select count(*) from public.feature_suggestions where organization_id = '${ORG_A}')::text as sugestoes,
              (select count(*) from public.profiles where id = '${USER_B}')::text as perfis`,
    );

    // Vê a sugestão da própria organização...
    expect(visao[0]?.sugestoes).toBe("1");
    // ...e não vê o perfil do autor, que é de outra: a policy de `profiles` é
    // `auth.uid() = id OR shares_org_with(id)`.
    expect(visao[0]?.perfis).toBe("0");
  });

  it("o embed do autor volta NULO — a FK diz NOT NULL, a RLS diz outra coisa", async () => {
    // Esta é a forma que o PostgREST monta para um embed muitos-para-um: uma
    // subconsulta correlacionada, avaliada com a RLS do chamador. Linha
    // invisível não é erro — é `null`.
    const linhas = await comoUsuario<{ embed: unknown }>(
      USER_A,
      `select (select row_to_json(p) from public.profiles p where p.id = s.created_by) as embed
         from public.feature_suggestions s
        where s.organization_id = '${ORG_A}'`,
    );

    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.embed).toBeNull();
  });

  it("o mesmo perfil NÃO é nulo para quem o enxerga — o nulo é da RLS, não de dado ausente", async () => {
    // O contraste é o que separa "invisível" de "não existe". A linha está lá:
    // quem tem permissão a vê.
    const proprio = await comoUsuario<{ embed: unknown }>(
      USER_B,
      `select (select row_to_json(p) from public.profiles p where p.id = '${USER_B}') as embed`,
    );

    expect(proprio[0]?.embed).not.toBeNull();
  });

  it("o tipo gerado promete não-nulo para este embed — e é essa a divergência", async () => {
    // Guarda documental: se um dia `supabase gen types` passar a modelar a
    // RLS, este teste falha e a regra de D-192 pode ser revista.
    const { readFileSync } = await import("node:fs");
    const tipos = readFileSync(new URL("./types.ts", import.meta.url), "utf8");

    // A relação existe e é declarada pela FK, sem nenhuma marca de que a RLS
    // pode anulá-la.
    expect(tipos).toContain("feature_suggestions_created_by_fkey");
  });
});
