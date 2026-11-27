import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, currentMembership, revalidatePath } = vi.hoisted(() => ({
  createClient: vi.fn(),
  currentMembership: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../../../../lib/membership", () => ({ currentMembership }));
vi.mock("../../../../lib/supabase/server", () => ({ createClient }));

import { removerDespesa, removerEntidadeFiscal, removerVinculoContaEntidade } from "./actions";

describe("remoção de registros da Central Financeira", () => {
  const select = vi.fn();
  const eqOrganizacao = vi.fn(() => ({ select }));
  const eqId = vi.fn(() => ({ eq: eqOrganizacao }));
  const from = vi.fn(() => ({ delete: () => ({ eq: eqId }) }));
  const dados = new FormData();
  dados.set("id", "registro-1");

  beforeEach(() => {
    vi.clearAllMocks();
    createClient.mockResolvedValue({ from });
    currentMembership.mockResolvedValue({ organizationId: "org-1" });
  });

  it.each([
    ["operational_expenses", removerDespesa],
    ["fiscal_entities", removerEntidadeFiscal],
    ["fiscal_entity_accounts", removerVinculoContaEntidade],
  ] as const)("confirma a exclusão em %s após receber o ID", async (tabela, remover) => {
    select.mockResolvedValueOnce({ data: [{ id: "registro-1" }], error: null });

    expect(await remover(dados)).toBeNull();
    expect(from).toHaveBeenCalledWith(tabela);
    expect(eqId).toHaveBeenCalledWith("id", "registro-1");
    expect(eqOrganizacao).toHaveBeenCalledWith("organization_id", "org-1");
    expect(select).toHaveBeenCalledWith("id");
    expect(revalidatePath).toHaveBeenCalledWith("/central/custos");
  });

  it("informa quando nenhuma linha foi removida", async () => {
    select.mockResolvedValueOnce({ data: [], error: null });

    expect(await removerDespesa(dados)).toContain("Nada foi removido");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("informa falha quando o banco recusa a exclusão", async () => {
    select.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });

    expect(await removerDespesa(dados)).toContain("Não foi possível confirmar a remoção");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
