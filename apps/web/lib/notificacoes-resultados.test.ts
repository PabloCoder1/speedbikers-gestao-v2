import { beforeEach, describe, expect, it, vi } from "vitest";

import { markNotificationRead } from "../app/(app)/notificacoes/actions";
import { deletePreference, updatePreference } from "../app/(app)/notificacoes/preferencias/actions";

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

const PREF_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const NOTIF_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

for (const caso of [
  {
    nome: "atualizar preferência",
    executar: () => updatePreference(PREF_ID, { minSeverity: "critico", enabled: false }),
    tabela: "notification_preferences",
    filtros: [["id", PREF_ID]],
    coluna: "id",
    retorno: { id: PREF_ID },
    caminho: "/notificacoes/preferencias",
    avisoErro: "Não foi possível atualizar a preferência.",
    avisoVazio: "A preferência não foi alterada",
    extraOk: {},
  },
  {
    nome: "remover preferência",
    executar: () => deletePreference(PREF_ID),
    tabela: "notification_preferences",
    filtros: [["id", PREF_ID]],
    coluna: "id",
    retorno: { id: PREF_ID },
    caminho: "/notificacoes/preferencias",
    avisoErro: "Não foi possível remover a preferência.",
    avisoVazio: "Nada foi removido",
    extraOk: {},
  },
  {
    nome: "marcar notificação como lida",
    executar: () => markNotificationRead(NOTIF_ID),
    tabela: "notification_recipients",
    filtros: [["notification_id", NOTIF_ID]],
    coluna: "notification_id",
    retorno: { notification_id: NOTIF_ID },
    caminho: "/notificacoes",
    avisoErro: "Não foi possível marcar como lida.",
    avisoVazio: "A notificação não foi marcada",
    extraOk: { marked: 1 },
  },
]) {
  describe(caso.nome, () => {
    it("recusa zero linhas sem anunciar sucesso nem revalidar a tela", async () => {
      m.retornar.mockResolvedValue({ data: [], error: null });
      const resultado = await caso.executar();
      expect(resultado.ok).toBe(false);
      expect(resultado.message).toContain(caso.avisoVazio);
      expect(resultado.message).toContain("Atualize a página para conferir");
      expect(m.revalidar).not.toHaveBeenCalled();
    });

    it("confirma a escrita somente com o alvo afetado", async () => {
      m.retornar.mockResolvedValue({ data: [caso.retorno], error: null });
      expect(await caso.executar()).toEqual({ ok: true, message: null, ...caso.extraOk });
      expect(m.tabela).toHaveBeenCalledExactlyOnceWith(caso.tabela);
      expect(m.filtrar.mock.calls).toEqual(caso.filtros);
      expect(m.retornar).toHaveBeenCalledExactlyOnceWith(caso.coluna);
      expect(m.revalidar).toHaveBeenCalledExactlyOnceWith(caso.caminho);
    });

    it("não divulga detalhes internos de um erro inesperado", async () => {
      m.retornar.mockResolvedValue({ data: null, error: { code: "XX000", message: "detalhe interno do banco" } });
      const resultado = await caso.executar();
      expect(resultado).toEqual({ ok: false, message: caso.avisoErro, ...(caso.nome.startsWith("marcar") ? { marked: null } : {}) });
      expect(resultado.message).not.toContain("detalhe interno");
      expect(m.revalidar).not.toHaveBeenCalled();
    });
  });
}
