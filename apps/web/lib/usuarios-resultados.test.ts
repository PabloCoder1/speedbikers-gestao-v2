import { beforeEach, describe, expect, it, vi } from "vitest";

import { changeMemberRole, revokeAccountAccess, revokeShopeeShopAccess } from "../app/(app)/usuarios/actions";

const m = vi.hoisted(() => ({
  cliente: vi.fn(),
  tabela: vi.fn(),
  atualizar: vi.fn(),
  apagar: vi.fn(),
  filtrar: vi.fn(),
  retornar: vi.fn(),
  revalidar: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidar }));
vi.mock("./supabase/server", () => ({ createClient: m.cliente }));

beforeEach(() => {
  vi.resetAllMocks();
  const consulta = { eq: m.filtrar, select: m.retornar };
  m.filtrar.mockReturnValue(consulta);
  m.atualizar.mockReturnValue(consulta);
  m.apagar.mockReturnValue(consulta);
  m.tabela.mockReturnValue({ update: m.atualizar, delete: m.apagar });
  m.cliente.mockResolvedValue({ from: m.tabela });
});

const ORG = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const CONTA = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

for (const caso of [
  { nome: "papel", executar: () => changeMemberRole(ORG, USER, "GESTOR"), tabela: "organization_members", filtros: [["organization_id", ORG], ["user_id", USER]], aviso: "O membro pode ter sido removido" },
  { nome: "ML", executar: () => revokeAccountAccess(USER, CONTA), tabela: "user_account_permissions", filtros: [["user_id", USER], ["ml_account_id", CONTA]], aviso: "Ele já pode ter sido removido" },
  { nome: "Shopee", executar: () => revokeShopeeShopAccess(USER, CONTA), tabela: "user_shopee_shop_permissions", filtros: [["user_id", USER], ["shopee_shop_id", CONTA]], aviso: "Ele já pode ter sido removido" },
]) {
  describe(caso.nome, () => {
    it("recusa zero linhas sem anunciar sucesso nem invalidar a tela", async () => {
      m.retornar.mockResolvedValue({ data: [], error: null });
      const resultado = await caso.executar();
      expect(resultado.ok).toBe(false);
      expect(resultado.message).toContain(caso.aviso);
      expect(resultado.message).toContain("Atualize a página para conferir");
      expect(m.revalidar).not.toHaveBeenCalled();
    });

    it("confirma a mudança somente com o alvo afetado e conserva o recorte", async () => {
      m.retornar.mockResolvedValue({ data: [{ user_id: USER }], error: null });
      expect(await caso.executar()).toEqual({ ok: true, message: null });
      expect(m.tabela).toHaveBeenCalledExactlyOnceWith(caso.tabela);
      expect(m.filtrar.mock.calls).toEqual(caso.filtros);
      expect(m.retornar).toHaveBeenCalledExactlyOnceWith("user_id");
      expect(m.revalidar).toHaveBeenCalledExactlyOnceWith("/usuarios");
    });

    it("mantém a recusa por autorização do banco", async () => {
      m.retornar.mockResolvedValue({ data: null, error: { code: "42501", message: "row-level security" } });
      expect(await caso.executar()).toEqual({ ok: false, message: "Só um ADMIN pode alterar acessos." });
      expect(m.revalidar).not.toHaveBeenCalled();
    });

    it("não divulga detalhes internos de um erro inesperado", async () => {
      m.retornar.mockResolvedValue({ data: null, error: { code: "XX000", message: "detalhe interno do banco" } });
      expect(await caso.executar()).toEqual({ ok: false, message: "Não foi possível aplicar a mudança." });
      expect(m.revalidar).not.toHaveBeenCalled();
    });
  });
}

it("preserva a orientação do bloqueio do último ADMIN", async () => {
  m.retornar.mockResolvedValue({ data: null, error: { code: "23514", message: "a organização ficaria sem nenhum ADMIN" } });
  expect(await changeMemberRole(ORG, USER, "GESTOR")).toEqual({
    ok: false,
    message: "A organização ficaria sem nenhum ADMIN. Promova outro membro antes de rebaixar ou remover este.",
  });
  expect(m.revalidar).not.toHaveBeenCalled();
});
