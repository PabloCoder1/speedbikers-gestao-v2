import { beforeEach, describe, expect, it, vi } from "vitest";

import { voltarAosPadroes } from "../app/(app)/central/limites/actions";
import { remover } from "../app/(app)/central/metas/actions";

const m = vi.hoisted(() => ({
  cliente: vi.fn(),
  membro: vi.fn(),
  tabela: vi.fn(),
  apagar: vi.fn(),
  filtrar: vi.fn(),
  retornar: vi.fn(),
  revalidar: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidar }));
vi.mock("./supabase/server", () => ({ createClient: m.cliente }));
vi.mock("./membership", () => ({ currentMembership: m.membro }));

beforeEach(() => {
  vi.resetAllMocks();
  const consulta = { eq: m.filtrar, select: m.retornar };
  m.filtrar.mockReturnValue(consulta);
  m.apagar.mockReturnValue(consulta);
  m.tabela.mockReturnValue({ delete: m.apagar });
  m.cliente.mockResolvedValue({ from: m.tabela });
  m.membro.mockResolvedValue({ organizationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", error: null });
});

function dadosDaMeta(): FormData {
  const dados = new FormData();
  dados.set("tabela", "monthly_goals");
  dados.set("id", "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
  return dados;
}

for (const caso of [
  { nome: "remover meta", executar: () => remover(dadosDaMeta()), caminhos: ["/central/metas", "/central", "/faturamento"] },
  { nome: "restaurar limites", executar: voltarAosPadroes, caminhos: ["/central/limites", "/central", "/central/ads"] },
]) {
  describe(caso.nome, () => {
    it("devolve o erro ao usuário sem expor detalhes internos nem invalidar telas", async () => {
      m.retornar.mockResolvedValue({ data: null, error: { code: "XX000", message: "detalhe interno do banco" } });
      const resultado = await caso.executar();
      expect(resultado).toContain("Não foi possível confirmar");
      expect(resultado).not.toContain("detalhe interno");
      expect(m.revalidar).not.toHaveBeenCalled();
    });

    it("não trata zero linhas afetadas como confirmação da alteração", async () => {
      m.retornar.mockResolvedValue({ data: [], error: null });
      expect(await caso.executar()).toContain("seu acesso foi alterado");
      expect(m.revalidar).not.toHaveBeenCalled();
    });

    it("invalida os consumidores somente após uma remoção confirmada", async () => {
      m.retornar.mockResolvedValue({ data: [{ id: "removido" }], error: null });
      expect(await caso.executar()).toBeNull();
      expect(m.revalidar.mock.calls).toEqual(caso.caminhos.map((caminho) => [caminho]));
    });
  });
}

it("recusa uma tabela fora da lista permitida sem consultar o banco", async () => {
  const dados = dadosDaMeta();
  dados.set("tabela", "organization_members");
  expect(await remover(dados)).toContain("identificar o registro");
  expect(m.cliente).not.toHaveBeenCalled();
  expect(m.revalidar).not.toHaveBeenCalled();
});

it("não restaura limites sem uma organização na sessão", async () => {
  m.membro.mockResolvedValue({ organizationId: null, error: null });
  expect(await voltarAosPadroes()).toContain("Sessão sem organização");
  expect(m.apagar).not.toHaveBeenCalled();
  expect(m.revalidar).not.toHaveBeenCalled();
});
