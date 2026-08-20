import { describe, expect, it } from "vitest";

import { AdminClientConfigError, createAdminClient } from "./admin-client.js";

const VALID = {
  supabaseUrl: "https://nmgccyqquwxecqffsidr.supabase.co",
  serviceRoleKey: "sb_secret_chave_de_teste_longa_o_bastante",
};

describe("createAdminClient", () => {
  it("cria o cliente com configuração válida", () => {
    expect(createAdminClient(VALID)).toBeDefined();
  });

  it("rejeita url vazia", () => {
    expect(() => createAdminClient({ ...VALID, supabaseUrl: "" })).toThrow(
      AdminClientConfigError,
    );
  });

  it("rejeita url que não é http(s)", () => {
    expect(() =>
      createAdminClient({ ...VALID, supabaseUrl: "nmgccyqquwxecqffsidr.supabase.co" }),
    ).toThrow(AdminClientConfigError);
  });

  it("rejeita chave ausente", () => {
    expect(() => createAdminClient({ ...VALID, serviceRoleKey: "" })).toThrow(
      AdminClientConfigError,
    );
  });

  it("nunca coloca a chave na mensagem de erro", () => {
    const segredo = "sb_secret_VALOR_QUE_NAO_PODE_VAZAR";

    try {
      createAdminClient({ supabaseUrl: "", serviceRoleKey: segredo });
      expect.unreachable("deveria ter lançado");
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);

      expect(mensagem).not.toContain(segredo);
      expect(mensagem).not.toContain("VALOR_QUE_NAO_PODE_VAZAR");
    }
  });

  it("não persiste sessão: processo de servidor não tem usuário logado", () => {
    const client = createAdminClient(VALID);

    expect(client.auth).toBeDefined();
  });
});
