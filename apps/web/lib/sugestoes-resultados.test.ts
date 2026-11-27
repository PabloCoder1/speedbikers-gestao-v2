import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateSuggestionStatus } from "../app/(app)/sugestoes/actions";

const m = vi.hoisted(() => ({
  cliente: vi.fn(),
  tabela: vi.fn(),
  atualizar: vi.fn(),
  filtrar: vi.fn(),
  retornar: vi.fn(),
  revalidar: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidar }));
vi.mock("./supabase/server", () => ({ createClient: m.cliente }));
vi.mock("./membership", () => ({ currentMembership: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  const consulta = { eq: m.filtrar, select: m.retornar };
  m.filtrar.mockReturnValue(consulta);
  m.atualizar.mockReturnValue(consulta);
  m.tabela.mockReturnValue({ update: m.atualizar });
  m.cliente.mockResolvedValue({ from: m.tabela });
});

const SUGGESTION_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

describe("updateSuggestionStatus", () => {
  it("recusa zero linhas sem anunciar sucesso nem revalidar a tela", async () => {
    m.retornar.mockResolvedValue({ data: [], error: null });

    const resultado = await updateSuggestionStatus(SUGGESTION_ID, "em_analise");

    expect(resultado.ok).toBe(false);
    expect(resultado.message).toContain("Atualize a página para conferir");
    expect(m.revalidar).not.toHaveBeenCalled();
  });

  it("confirma a escrita somente com o id afetado", async () => {
    m.retornar.mockResolvedValue({ data: [{ id: SUGGESTION_ID }], error: null });

    expect(await updateSuggestionStatus(SUGGESTION_ID, "em_analise")).toEqual({ ok: true, message: null });
    expect(m.tabela).toHaveBeenCalledExactlyOnceWith("feature_suggestions");
    expect(m.atualizar).toHaveBeenCalledExactlyOnceWith({ status: "em_analise" });
    expect(m.filtrar.mock.calls).toEqual([["id", SUGGESTION_ID]]);
    expect(m.retornar).toHaveBeenCalledExactlyOnceWith("id");
    expect(m.revalidar).toHaveBeenCalledExactlyOnceWith("/sugestoes");
  });

  it("não divulga detalhes internos em erro do banco", async () => {
    m.retornar.mockResolvedValue({ data: null, error: { code: "42501", message: "detalhe interno RLS" } });

    const resultado = await updateSuggestionStatus(SUGGESTION_ID, "aprovada");

    expect(resultado).toEqual({
      ok: false,
      message: "Não foi possível atualizar — só ADMIN/GESTOR muda o status.",
    });
    expect(resultado.message).not.toContain("detalhe interno");
    expect(m.revalidar).not.toHaveBeenCalled();
  });
});
