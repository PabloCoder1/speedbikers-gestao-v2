import { beforeEach, describe, expect, it, vi } from "vitest";

import { claimAction } from "../app/(app)/acoes/actions";
import { assignToMe } from "../app/(app)/atendimento/actions";
import { createKnowledgeEntry, setKnowledgeStatus } from "../app/(app)/atendimento/conhecimento/actions";
import { createTemplate, updateTemplate } from "../app/(app)/atendimento/templates/actions";
import { salvarLimites, voltarAosPadroes } from "../app/(app)/central/limites/actions";
import { salvarMeta } from "../app/(app)/central/metas/actions";
import { diagnoseSku } from "../app/(app)/skus/[skuId]/actions";
import { createSuggestion } from "../app/(app)/sugestoes/actions";

const m = vi.hoisted(() => ({
  createClient: vi.fn(),
  currentMembership: vi.fn(),
  revalidatePath: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("./supabase/server", () => ({ createClient: m.createClient }));
vi.mock("./membership", () => ({ currentMembership: m.currentMembership }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.resetAllMocks();
  m.getUser.mockResolvedValue({ data: { user: { id: SESSION_USER } }, error: null });
  m.currentMembership.mockResolvedValue({ organizationId: ORG_ID, role: "ADMIN", error: null });
  m.rpc.mockResolvedValue({ data: null, error: null });
  m.createClient.mockResolvedValue({
    auth: { getUser: m.getUser },
    rpc: m.rpc,
    from: m.from,
  });
});

describe("D-778: autorização e fail-closed nas Server Actions", () => {
  it("claimAction deriva o responsável da sessão no servidor e ignora id forjado pelo cliente", async () => {
    const resultado = await (Reflect.apply(claimAction, undefined, [TARGET_ID, OTHER_USER]) as Promise<{
      ok: boolean;
      message: string | null;
    }>);

    expect(resultado).toEqual({ ok: true, message: null });
    expect(m.getUser).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith("update_action_status", {
      p_id: TARGET_ID,
      p_status: "em_andamento",
      p_assignee_id: SESSION_USER,
    });
  });

  it("assignToMe falha fechado quando a leitura de support_cases retorna erro de banco", async () => {
    m.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "connection timeout" } }),
        }),
      }),
    });

    const resultado = await assignToMe(TARGET_ID);

    expect(resultado.ok).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("createKnowledgeEntry separa erro de organização, erro de consulta de SKU e não vaza erro cru do Postgres", async () => {
    m.currentMembership.mockResolvedValueOnce({
      organizationId: null,
      role: null,
      error: "timeout em get_current_membership",
    });

    const falhaOrg = await createKnowledgeEntry({
      kind: "COMPATIBILIDADE",
      source: "CONFIRMACAO_INTERNA",
      content: "Compatível com aro 29",
      note: "",
      skuCode: "",
    });

    expect(falhaOrg.ok).toBe(false);
    expect(falhaOrg.message).toMatch(/confirmar sua organização|verificar sua organização/i);
    expect(falhaOrg.message).not.toMatch(/expirada/i);

    // Erro transitório ao consultar SKU não pode dizer "SKU não encontrado"
    m.from.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "relation skus timeout" } }),
        }),
      }),
    });

    const falhaSku = await createKnowledgeEntry({
      kind: "COMPATIBILIDADE",
      source: "CONFIRMACAO_INTERNA",
      content: "Compatível com aro 29",
      note: "",
      skuCode: "SKU-1",
    });

    expect(falhaSku.ok).toBe(false);
    expect(falhaSku.message).not.toMatch(/não encontrado/i);

    // Erro inesperado no insert não pode expor mensagem crua do Postgres
    m.from.mockReturnValueOnce({
      insert: () => Promise.resolve({ data: null, error: { message: 'relation "knowledge_entries" violated internal constraint' } }),
    });

    const falhaInsert = await createKnowledgeEntry({
      kind: "COMPATIBILIDADE",
      source: "CONFIRMACAO_INTERNA",
      content: "Compatível com aro 29",
      note: "",
      skuCode: "",
    });

    expect(falhaInsert.ok).toBe(false);
    expect(falhaInsert.message).not.toContain("knowledge_entries");
  });

  it("setKnowledgeStatus não vaza mensagem crua do Postgres em falha inesperada", async () => {
    m.from.mockReturnValueOnce({
      update: () => ({
        eq: () => ({
          select: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: null, error: { message: 'permission denied for relation "knowledge_entries"' } }),
          }),
        }),
      }),
    });

    const resultado = await setKnowledgeStatus(TARGET_ID, "VALIDADO");

    expect(resultado.ok).toBe(false);
    expect(resultado.message).not.toContain("knowledge_entries");
  });

  it("diagnoseSku separa falha de banco de SKU inexistente", async () => {
    m.from.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "db connection lost" } }),
        }),
      }),
    });

    const resultado = await diagnoseSku(TARGET_ID);

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.message).not.toMatch(/não encontrado/i);
    }
  });

  it("templates, limites, metas e sugestões separam erro de organização de ausência e não vazam SQL cru", async () => {
    m.currentMembership.mockResolvedValue({
      organizationId: null,
      role: null,
      error: "db unavailable",
    });

    const rTemplate = await createTemplate("Nome", "Corpo");
    expect(rTemplate.ok).toBe(false);
    expect(rTemplate.message).toMatch(/organização/i);
    expect(rTemplate.message).not.toMatch(/expirada/i);

    const rLimite = await salvarLimites({ ok: false, mensagem: null, erros: {} }, new FormData());
    expect(rLimite.ok).toBe(false);
    expect(rLimite.mensagem).toMatch(/confirmar sua organização|verificar sua organização/i);
    expect(rLimite.mensagem).not.toMatch(/sem organização/i);

    const rPadrao = await voltarAosPadroes();
    expect(rPadrao).toMatch(/confirmar sua organização|verificar sua organização/i);
    expect(rPadrao).not.toMatch(/sem organização/i);

    const rMeta = await salvarMeta({ ok: false, mensagem: null, erros: {} }, new FormData());
    expect(rMeta.ok).toBe(false);
    expect(rMeta.mensagem).toMatch(/confirmar sua organização|verificar sua organização/i);
    expect(rMeta.mensagem).not.toMatch(/sem organização/i);

    const rSugestao = await createSuggestion("Melhoria X");
    expect(rSugestao.ok).toBe(false);
    expect(rSugestao.message).toMatch(/confirmar sua organização|verificar sua organização/i);
    expect(rSugestao.message).not.toMatch(/expirada/i);

    // Erro inesperado no update de template não vaza mensagem crua do Postgres
    m.currentMembership.mockResolvedValue({ organizationId: ORG_ID, role: "ADMIN", error: null });
    m.from.mockReturnValueOnce({
      update: () => ({
        eq: () => ({
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: { code: "XX000", message: 'pg internal "reply_templates"' } }),
          }),
        }),
      }),
    });

    const rUpdate = await updateTemplate(TARGET_ID, "Nome", "Corpo");
    expect(rUpdate.ok).toBe(false);
    expect(rUpdate.message).not.toContain("reply_templates");
  });
});
