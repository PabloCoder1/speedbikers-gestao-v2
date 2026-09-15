import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { Caller } from "./auth.js";
import type { InviteDeps } from "./invites.js";
import { setMemberSuspension } from "./member-suspension.js";

/**
 * Suspender e reativar (D-354).
 *
 * Como no convite, o que se protege é a FRONTEIRA: `AdminClient` atravessa a
 * RLS, e um defeito aqui tranca a conta de alguém de outra empresa.
 */

const ORG = "11111111-0000-4000-8000-000000000001";
const OUTRA_ORG = "22222222-0000-4000-8000-000000000002";
const ADMIN: Caller = { userId: "u-admin", organizationId: ORG, role: "ADMIN" };

interface FakeOptions {
  /** Organizações em que o alvo tem vínculo. */
  organizacoes?: string[];
  /** `banned_until` atual do alvo no Auth. */
  banidoAte?: string | null;
  falhaNoEvento?: boolean;
}

interface Registro {
  bans: { userId: string; ban_duration: string }[];
  eventos: unknown[];
}

function fakeDeps(options: FakeOptions = {}): { deps: InviteDeps; registro: Registro } {
  const registro: Registro = { bans: [], eventos: [] };
  const organizacoes = options.organizacoes ?? [ORG];

  const db = {
    from: (tabela: string) => ({
      select: () => ({
        eq: () =>
          Promise.resolve({ data: organizacoes.map((id) => ({ organization_id: id })), error: null }),
      }),
      insert: (linha: unknown) => {
        if (tabela === "organization_access_events") registro.eventos.push(linha);

        return Promise.resolve({ error: options.falhaNoEvento === true ? { message: "check violado" } : null });
      },
    }),
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({ data: { user: { id, banned_until: options.banidoAte ?? undefined } }, error: null }),
        updateUserById: (userId: string, atributos: { ban_duration: string }) => {
          registro.bans.push({ userId, ban_duration: atributos.ban_duration });

          return Promise.resolve({ data: { user: { id: userId } }, error: null });
        },
      },
    },
  } as unknown as InviteDeps["db"];

  return { deps: { db, logger: createLogger({}, { sink: () => undefined }) }, registro };
}

const FUTURO = new Date(Date.now() + 86_400_000).toISOString();
const PASSADO = new Date(Date.now() - 86_400_000).toISOString();

describe("setMemberSuspension (D-354)", () => {
  it("suspende no Auth e grava o evento com QUEM suspendeu", async () => {
    const { deps, registro } = fakeDeps();

    const outcome = await setMemberSuspension(deps, ADMIN, "u-alvo", true);

    expect(outcome).toEqual({ status: "ok", suspended: true, changed: true });
    expect(registro.bans).toEqual([{ userId: "u-alvo", ban_duration: "876000h" }]);
    expect(registro.eventos).toEqual([
      { organization_id: ORG, event_type: "MEMBER_SUSPENDED", target_user_id: "u-alvo", actor_user_id: "u-admin" },
    ]);
  });

  it("reativar tira o ban (`none`) e grava MEMBER_REACTIVATED", async () => {
    const { deps, registro } = fakeDeps({ banidoAte: FUTURO });

    const outcome = await setMemberSuspension(deps, ADMIN, "u-alvo", false);

    expect(outcome).toEqual({ status: "ok", suspended: false, changed: true });
    expect(registro.bans).toEqual([{ userId: "u-alvo", ban_duration: "none" }]);
    expect(registro.eventos).toEqual([expect.objectContaining({ event_type: "MEMBER_REACTIVATED" })]);
  });

  /** Dois cliques não viram duas suspensões no histórico. */
  it("pedir o estado que já vale não escreve nada", async () => {
    const { deps, registro } = fakeDeps({ banidoAte: FUTURO });

    const outcome = await setMemberSuspension(deps, ADMIN, "u-alvo", true);

    expect(outcome).toEqual({ status: "ok", suspended: true, changed: false });
    expect(registro.bans).toEqual([]);
    expect(registro.eventos).toEqual([]);
  });

  /** Ban vencido não impede a entrada: a pessoa conta como ativa. */
  it("ban no passado conta como NÃO suspenso", async () => {
    const { deps, registro } = fakeDeps({ banidoAte: PASSADO });

    await setMemberSuspension(deps, ADMIN, "u-alvo", true);

    expect(registro.bans).toHaveLength(1);
  });

  it("recusa suspender a si mesmo, antes de qualquer leitura", async () => {
    const { deps, registro } = fakeDeps();

    const outcome = await setMemberSuspension(deps, ADMIN, "u-admin", true);

    expect(outcome).toEqual({ status: "invalid", reason: "você não pode suspender o próprio acesso" });
    expect(registro.bans).toEqual([]);
  });

  /* A FRONTEIRA: quem não é membro daqui não é tocado. */
  it("quem não é membro desta organização não é suspenso", async () => {
    const { deps, registro } = fakeDeps({ organizacoes: [OUTRA_ORG] });

    const outcome = await setMemberSuspension(deps, ADMIN, "u-de-fora", true);

    expect(outcome).toEqual({ status: "not_member" });
    expect(registro.bans).toEqual([]);
  });

  /* O ban é da CONTA: suspender aqui trancaria a pessoa na outra empresa. */
  it("quem também é membro de outra organização é recusado", async () => {
    const { deps, registro } = fakeDeps({ organizacoes: [ORG, OUTRA_ORG] });

    const outcome = await setMemberSuspension(deps, ADMIN, "u-alvo", true);

    expect(outcome.status).toBe("invalid");
    expect(registro.bans).toEqual([]);
  });

  /* A suspensão valeu e o histórico não: dizer as duas coisas. */
  it("evento que falha é DITO, com a suspensão já aplicada", async () => {
    const { deps, registro } = fakeDeps({ falhaNoEvento: true });

    const outcome = await setMemberSuspension(deps, ADMIN, "u-alvo", true);

    expect(registro.bans).toHaveLength(1);
    expect(outcome.status).toBe("error");
    expect(outcome).toHaveProperty("reason", expect.stringContaining("acesso suspenso, mas o histórico não registrou"));
  });
});
