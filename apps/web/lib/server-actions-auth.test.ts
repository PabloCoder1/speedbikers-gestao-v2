import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  authError: null as { message: string } | null,
  userId: "user-1" as string | null,
  membershipOrgId: "org-1" as string | null,
  rpcError: null as { message: string } | null,
};

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("../lib/membership", () => ({
  currentMembership: () =>
    Promise.resolve({
      organizationId: state.membershipOrgId,
      role: "ADMIN",
      error: null,
    }),
}));

vi.mock("../lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: state.userId === null ? null : { id: state.userId } },
            error: state.authError,
          }),
      },
      rpc: () => Promise.resolve({ data: null, error: state.rpcError }),
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { internal_status: "NOVO" }, error: null }),
          }),
        }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: { id: "row-1" }, error: null }),
            }),
          }),
        }),
      }),
    }),
}));

import { assignToMe, changePriority } from "../app/(app)/atendimento/actions";
import { createKnowledgeEntry, setKnowledgeStatus } from "../app/(app)/atendimento/conhecimento/actions";
import { createTemplate } from "../app/(app)/atendimento/templates/actions";
import { createPreference } from "../app/(app)/notificacoes/preferencias/actions";
import { createSuggestion } from "../app/(app)/sugestoes/actions";

describe("Server Actions — fail-closed em erro de auth.getUser e sem vazamento de erro SQL (D-820)", () => {
  beforeEach(() => {
    state.authError = null;
    state.userId = "user-1";
    state.membershipOrgId = "org-1";
    state.rpcError = null;
  });

  it("falha transitória em auth.getUser não é mascarada como 'Sessão expirada' nas 6 Server Actions", async () => {
    state.authError = { message: "auth service 503" };
    state.userId = null;

    const results = await Promise.all([
      assignToMe("case-1"),
      createKnowledgeEntry({ kind: "COMPATIBILIDADE", source: "CONFIRMACAO_INTERNA", content: "Fato", note: "", skuCode: "" }),
      setKnowledgeStatus("k-1", "VALIDADO"),
      createTemplate("T1", "Corpo"),
      createPreference({ eventType: null, mlAccountId: null, minSeverity: "INFO", enabled: true }),
      createSuggestion("Melhoria"),
    ]);

    for (const res of results) {
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/confirmar sua sessão/i);
      expect(res.message).not.toMatch(/expirada/i);
    }
  });

  it("atendimento/actions.ts não devolve texto cru do Postgres contendo detalhes/UUIDs", async () => {
    state.rpcError = {
      message: "papel sem permissao para usuario 11111111-1111-4111-8111-111111111111 na tabela support_cases",
    };

    const res = await changePriority("case-1", "ALTA");

    expect(res.ok).toBe(false);
    expect(res.message).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(res.message).not.toContain("support_cases");
    expect(res.message).toMatch(/permissão/i);
  });
});
