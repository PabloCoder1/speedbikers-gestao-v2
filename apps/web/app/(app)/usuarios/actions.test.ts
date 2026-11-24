import { beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePathMock, createClientMock } = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("../../../lib/supabase/server", () => ({
  createClient: createClientMock,
}));

import { removeMember } from "./actions";

describe("removeMember (D-811)", () => {
  beforeEach(() => {
    revalidatePathMock.mockReset();
    createClientMock.mockReset();
  });

  it("falha fechado quando auth.getUser falha ou não retorna usuário, sem apagar vínculo", async () => {
    const deleteOrgMember = vi.fn();

    createClientMock.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: "auth down" } }),
      },
      from: vi.fn(() => ({ delete: deleteOrgMember })),
    });

    const result = await removeMember("org-1", "user-2");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Sessão");
    expect(deleteOrgMember).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("impede auto-remoção pelo próprio usuário autenticado", async () => {
    const deleteOrgMember = vi.fn();

    createClientMock.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }),
      },
      from: vi.fn(() => ({ delete: deleteOrgMember })),
    });

    const result = await removeMember("org-1", "user-1");

    expect(result).toEqual({
      ok: false,
      message: "Você não pode remover o próprio acesso. Peça a outro ADMIN.",
    });
    expect(deleteOrgMember).not.toHaveBeenCalled();
  });

  it("reporta falha parcial e revalida quando a leitura de ml_accounts falha após apagar o vínculo", async () => {
    const rangeMock = vi.fn().mockResolvedValue({ data: null, error: { message: "db timeout" } });

    createClientMock.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }),
      },
      from: vi.fn((table: string) => {
        if (table === "organization_members") {
          return {
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => Promise.resolve({ data: [{ user_id: "user-2" }], error: null }),
                }),
              }),
            }),
          };
        }

        if (table === "ml_accounts") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: rangeMock,
                }),
                then: (resolve: (v: unknown) => void) => {
                  resolve({ data: null, error: { message: "db timeout" } });
                },
              }),
            }),
          };
        }

        throw new Error(`unexpected table ${table}`);
      }),
    });

    const result = await removeMember("org-1", "user-2");

    expect(result).toEqual({
      ok: false,
      message: "A pessoa foi removida, mas as permissões por conta não foram apagadas. Elas não valem sem o vínculo.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/usuarios");
  });

  it("pagina ml_accounts além de 1.000 linhas e limpa user_account_permissions em lotes de no máximo 100 IDs", async () => {
    const todasContas = Array.from({ length: 1050 }, (_, idx) => ({ id: `acc-${String(idx).padStart(4, "0")}` }));
    const rangesLidos: [number, number][] = [];
    const lotesApagados: string[][] = [];

    createClientMock.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }),
      },
      from: vi.fn((table: string) => {
        if (table === "organization_members") {
          return {
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => Promise.resolve({ data: [{ user_id: "user-2" }], error: null }),
                }),
              }),
            }),
          };
        }

        if (table === "ml_accounts") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: (from: number, to: number) => {
                    rangesLidos.push([from, to]);
                    return Promise.resolve({ data: todasContas.slice(from, to + 1), error: null });
                  },
                }),
              }),
            }),
          };
        }

        if (table === "user_account_permissions") {
          return {
            delete: () => ({
              eq: () => ({
                in: (_col: string, ids: string[]) => {
                  lotesApagados.push(ids);
                  return Promise.resolve({ error: null });
                },
              }),
            }),
          };
        }

        throw new Error(`unexpected table ${table}`);
      }),
    });

    const result = await removeMember("org-1", "user-2");

    expect(result).toEqual({ ok: true, message: null });
    expect(rangesLidos.length).toBeGreaterThanOrEqual(2);
    expect(lotesApagados.length).toBe(11);
    expect(lotesApagados.every((lote) => lote.length <= 100)).toBe(true);
    expect(lotesApagados.flat()).toHaveLength(1050);
    expect(revalidatePathMock).toHaveBeenCalledWith("/usuarios");
  });

  it("reporta falha parcial quando um lote subsequente de user_account_permissions falha", async () => {
    const contas = Array.from({ length: 150 }, (_, idx) => ({ id: `acc-${String(idx)}` }));
    let chamada = 0;

    createClientMock.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }),
      },
      from: vi.fn((table: string) => {
        if (table === "organization_members") {
          return {
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => Promise.resolve({ data: [{ user_id: "user-2" }], error: null }),
                }),
              }),
            }),
          };
        }

        if (table === "ml_accounts") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  range: (from: number, to: number) =>
                    Promise.resolve({ data: contas.slice(from, to + 1), error: null }),
                }),
              }),
            }),
          };
        }

        if (table === "user_account_permissions") {
          return {
            delete: () => ({
              eq: () => ({
                in: () => {
                  chamada += 1;
                  return Promise.resolve({ error: chamada === 2 ? { message: "deadlock" } : null });
                },
              }),
            }),
          };
        }

        throw new Error(`unexpected table ${table}`);
      }),
    });

    const result = await removeMember("org-1", "user-2");

    expect(result).toEqual({
      ok: false,
      message: "A pessoa foi removida, mas as permissões por conta não foram apagadas. Elas não valem sem o vínculo.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/usuarios");
  });
});
