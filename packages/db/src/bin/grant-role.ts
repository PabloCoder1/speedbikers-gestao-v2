/**
 * Concede papel de uma organizacao a um usuario que JA existe no Supabase Auth.
 *
 * Uso:
 *   node packages/db/src/bin/grant-role.ts --email pessoa@exemplo.com --role ADMIN
 *
 * Este script NAO cria login e NAO define senha. A conta e criada no painel do
 * Supabase (Authentication > Users), onde a propria pessoa define a senha —
 * senha nao passa por aqui, nem por arquivo, nem por log.
 *
 * O script existe porque a primeira conta e um problema de ovo e galinha: so
 * ADMIN pode conceder papel (policy `organization_members_admin_writes`), e no
 * comeco nao ha ADMIN nenhum. Ele usa `service_role`, que ignora RLS, para
 * quebrar o ciclo uma vez. Depois disso, promocoes saem pela interface.
 */

import { createClient } from "@supabase/supabase-js";

import type { Database } from "../types.js";

const ROLES = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

type Role = (typeof ROLES)[number];

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`erro: ${message}\n`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const email = arg("email")?.trim().toLowerCase();
  const role = (arg("role") ?? "ADMIN").toUpperCase();
  const slug = arg("org") ?? "speed-bikers";

  if (email === undefined || email === "") {
    fail("informe --email");
  }

  if (!(ROLES as readonly string[]).includes(role)) {
    fail(`papel invalido: ${role}. Use um de ${ROLES.join(", ")}`);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (url === undefined || key === undefined) {
    fail("defina SUPABASE_URL e SUPABASE_SECRET_KEY no ambiente");
  }

  const db = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // O Auth nao oferece busca por e-mail; a listagem e paginada. Com dezenas de
  // usuarios internos isso e trivial, e evita depender do schema `auth` direto.
  let user: { id: string; email?: string } | undefined;

  for (let page = 1; page <= 20 && user === undefined; page += 1) {
    const listed = await db.auth.admin.listUsers({ page, perPage: 200 });

    if (listed.error !== null) {
      fail(listed.error.message);
    }

    if (listed.data.users.length === 0) {
      break;
    }

    user = listed.data.users.find((candidate) => candidate.email?.toLowerCase() === email);
  }

  if (user === undefined) {
    fail(
      `nenhum usuario com e-mail ${email}. Crie a conta em ` +
        `Authentication > Users no painel do Supabase e rode de novo.`,
    );
  }

  const org = await db.from("organizations").select("id, name").eq("slug", slug).maybeSingle();

  if (org.error !== null) {
    fail(org.error.message);
  }

  if (org.data === null) {
    fail(`organizacao '${slug}' nao existe. Aplique as migrations primeiro.`);
  }

  // O trigger `on_auth_user_created` cria o perfil, mas so dispara em contas
  // criadas DEPOIS da migration de identidade. Garantir aqui torna o script
  // seguro para contas anteriores.
  const profile = await db.from("profiles").upsert({ id: user.id }, { onConflict: "id" });

  if (profile.error !== null) {
    fail(profile.error.message);
  }

  const membership = await db
    .from("organization_members")
    .upsert(
      { organization_id: org.data.id, user_id: user.id, role: role as Role },
      { onConflict: "organization_id,user_id" },
    );

  if (membership.error !== null) {
    fail(membership.error.message);
  }

  out(`${email} agora e ${role} em ${org.data.name}.`);
}

await main();
