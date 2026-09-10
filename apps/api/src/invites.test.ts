import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { Caller } from "./auth.js";
import type { InviteDeps } from "./invites.js";
import { inviteOrganizationMember, reissueAccessLink } from "./invites.js";

/**
 * Convite de usuário (D-296).
 *
 * O que estes casos protegem não é o caminho feliz: é a **fronteira de
 * organização**. `AdminClient` atravessa a RLS, então aqui o banco não defende
 * ninguém — quem defende é o código, e um defeito nesta função vira acesso
 * concedido à conta de outra empresa.
 */

const ORG = "11111111-0000-4000-8000-000000000001";
const CONTA = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN: Caller = { userId: "u-admin", organizationId: ORG, role: "ADMIN" };

interface FakeOptions {
  /** Membro encontrado (ou não) pela consulta de `reissueAccessLink`. */
  membroExiste?: boolean;
  /** E-mail devolvido por `getUserById`. */
  emailDoAlvo?: string | null;
  /** Contas que a consulta por organização devolve (o filtro é do fake). */
  contasDaOrganizacao?: string[];
  /** Usuários já existentes no Auth, por e-mail. */
  usuarios?: { id: string; email: string }[];
  jaMembro?: boolean;
  falhaNaPermissao?: boolean;
}

function fakeDeps(options: FakeOptions = {}): { deps: InviteDeps; escritas: { tabela: string; linha: unknown }[] } {
  const contas = options.contasDaOrganizacao ?? [CONTA];
  const usuarios = options.usuarios ?? [];
  const escritas: { tabela: string; linha: unknown }[] = [];

  const db = {
    from: (tabela: string) => ({
      select: () => ({
        eq: () => ({
          // ml_accounts: .select().eq(org).in(ids)
          in: (_coluna: string, ids: string[]) =>
            Promise.resolve({ data: ids.filter((id) => contas.includes(id)).map((id) => ({ id })), error: null }),
          // organization_members: .select().eq(org).eq(user).maybeSingle()
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data:
                  options.jaMembro === true || options.membroExiste === true
                    ? { user_id: "u-existente" }
                    : null,
                error: null,
              }),
          }),
        }),
      }),
      insert: (linha: unknown) => {
        escritas.push({ tabela, linha });

        if (tabela === "user_account_permissions" && options.falhaNaPermissao === true) {
          return Promise.resolve({ error: { message: "permissão recusada" } });
        }

        return Promise.resolve({ error: null });
      },
    }),
    auth: {
      admin: {
        listUsers: () => Promise.resolve({ data: { users: usuarios }, error: null }),
        getUserById: (id: string) =>
          Promise.resolve({
            data: { user: { id, email: options.emailDoAlvo === undefined ? "alvo@empresa.com" : options.emailDoAlvo } },
            error: null,
          }),
        generateLink: ({ email }: { email: string }) =>
          Promise.resolve({
            data: {
              user: { id: `novo-${email}` },
              properties: { action_link: `https://auth.local/invite?token=abc&email=${email}` },
            },
            error: null,
          }),
      },
    },
  } as unknown as InviteDeps["db"];

  return { deps: { db, logger: createLogger({}, { sink: () => undefined }) }, escritas };
}

describe("inviteOrganizationMember (D-296)", () => {
  it("e-mail novo: cria o usuário, devolve o LINK e vincula com o papel pedido", async () => {
    const { deps, escritas } = fakeDeps();

    const outcome = await inviteOrganizationMember(deps, ADMIN, {
      email: "Nova.Pessoa@Empresa.com",
      role: "OPERADOR",
      mlAccountIds: [CONTA],
    });

    expect(outcome.status).toBe("invited");
    expect(outcome).toHaveProperty("inviteLink");

    const vinculo = escritas.find((e) => e.tabela === "organization_members");

    expect(vinculo?.linha).toEqual({
      organization_id: ORG,
      // O e-mail é normalizado antes de virar usuário: convidar
      // "Nova.Pessoa@Empresa.com" duas vezes com caixas diferentes criaria
      // duas contas para a mesma pessoa.
      user_id: "novo-nova.pessoa@empresa.com",
      role: "OPERADOR",
    });

    expect(escritas.find((e) => e.tabela === "user_account_permissions")).toBeDefined();
  });

  /*
    A FRONTEIRA. `AdminClient` ignora a RLS: sem esta checagem, um id de conta
    de outra organização no payload viraria permissão de verdade.
  */
  it("conta que não é da organização do chamador é RECUSADA", async () => {
    const { deps, escritas } = fakeDeps({ contasDaOrganizacao: [] });

    const outcome = await inviteOrganizationMember(deps, ADMIN, {
      email: "alguem@empresa.com",
      role: "ANALISTA",
      mlAccountIds: ["bbbbbbbb-0000-4000-8000-000000000009"],
    });

    expect(outcome).toEqual({ status: "invalid", reason: "conta que não pertence a esta organização" });
    // E nada foi escrito: a recusa acontece ANTES de criar usuário.
    expect(escritas).toEqual([]);
  });

  /** Quem já tem conta no sistema não é erro: vira vínculo, sem link a aceitar. */
  it("e-mail que já existe no Auth vira VÍNCULO, sem convite", async () => {
    const { deps, escritas } = fakeDeps({ usuarios: [{ id: "u-existente", email: "ja@empresa.com" }] });

    const outcome = await inviteOrganizationMember(deps, ADMIN, { email: "ja@empresa.com", role: "GESTOR" });

    expect(outcome).toEqual({ status: "linked", userId: "u-existente" });
    expect(escritas.find((e) => e.tabela === "organization_members")).toBeDefined();
  });

  /** Convidar de novo quem já é membro não muda papel nem alcance — isso é o outro comando. */
  it("quem já é membro não é reescrito", async () => {
    const { deps, escritas } = fakeDeps({
      usuarios: [{ id: "u-existente", email: "ja@empresa.com" }],
      jaMembro: true,
    });

    const outcome = await inviteOrganizationMember(deps, ADMIN, { email: "ja@empresa.com", role: "ADMIN" });

    expect(outcome).toEqual({ status: "already_member" });
    expect(escritas).toEqual([]);
  });

  /*
    O vínculo existe e a permissão falhou: dizer que deu certo esconderia uma
    pessoa que entra sem alcance nenhum. Desfazer seria pior — deixaria um
    usuário no Auth sem organização, que é órfão de verdade.
  */
  it("permissão de conta que falha é DITA, com o vínculo já criado", async () => {
    const { deps } = fakeDeps({ falhaNaPermissao: true });

    const outcome = await inviteOrganizationMember(deps, ADMIN, {
      email: "nova@empresa.com",
      role: "OPERADOR",
      mlAccountIds: [CONTA],
    });

    expect(outcome.status).toBe("error");
    expect(outcome).toHaveProperty("reason", expect.stringContaining("membro criado"));
  });

  /** O e-mail NUNCA vai para o log — nem o domínio sozinho identifica alguém. */
  it("o log não carrega o e-mail de quem foi convidado", async () => {
    const registros: unknown[] = [];
    const { deps } = fakeDeps();
    const logger = createLogger({}, { sink: (linha) => registros.push(linha) });

    await inviteOrganizationMember({ ...deps, logger }, ADMIN, {
      email: "sigilo@empresa.com",
      role: "VISUALIZADOR",
    });

    expect(JSON.stringify(registros)).not.toContain("sigilo@empresa.com");
    expect(JSON.stringify(registros)).toContain("invite_created");
  });
});

/**
 * REEMITIR LINK DE ACESSO (D-303).
 *
 * O que estes casos protegem é a mesma fronteira do convite, no ponto onde ela
 * custa mais caro: o link vale como senha da conta de destino, e `AdminClient`
 * atravessa a RLS. Sem a checagem de membro, um ADMIN emitiria acesso para a
 * conta de qualquer usuário do sistema — inclusive de outra empresa.
 */
describe("reissueAccessLink (D-303)", () => {
  it("membro desta organização recebe um link novo", async () => {
    const { deps } = fakeDeps({ membroExiste: true });

    const outcome = await reissueAccessLink(deps, ADMIN, "u-existente");

    expect(outcome.status).toBe("issued");
    expect(outcome).toHaveProperty("link", expect.stringContaining("https://auth.local/invite"));
  });

  /*
    A FRONTEIRA. "Não é membro daqui" e "não existe" têm a MESMA resposta:
    distinguir as duas contaria a um ADMIN quem existe no sistema inteiro.
  */
  it("quem não é membro desta organização NÃO recebe link", async () => {
    const { deps } = fakeDeps({ membroExiste: false });

    const outcome = await reissueAccessLink(deps, ADMIN, "u-de-outra-empresa");

    expect(outcome).toEqual({ status: "not_member" });
  });

  /** Sem e-mail no Auth não há para onde mandar — e inventar um seria criar
   *  acesso para um endereço que ninguém escolheu. */
  it("membro sem e-mail no Auth é recusado com o motivo", async () => {
    const { deps } = fakeDeps({ membroExiste: true, emailDoAlvo: null });

    const outcome = await reissueAccessLink(deps, ADMIN, "u-existente");

    expect(outcome.status).toBe("error");
    expect(outcome).toHaveProperty("reason", expect.stringContaining("não tem e-mail"));
  });

  /** Nem o e-mail nem o LINK vão para o log: os dois são credencial, e log é o
   *  lugar que mais gente lê depois. */
  it("o log não carrega e-mail nem link", async () => {
    const registros: unknown[] = [];
    const { deps } = fakeDeps({ membroExiste: true, emailDoAlvo: "sigilo@empresa.com" });
    const logger = createLogger({}, { sink: (linha) => registros.push(linha) });

    await reissueAccessLink({ ...deps, logger }, ADMIN, "u-existente");

    const escrito = JSON.stringify(registros);

    expect(escrito).not.toContain("sigilo@empresa.com");
    expect(escrito).not.toContain("https://auth.local");
    expect(escrito).toContain("access_link_issued");
  });
});
