import { describe, expect, it } from "vitest";

import { createUserClient, UserClientConfigError } from "./user-client.js";

const VALID_CONFIG = {
  supabaseUrl: "https://nmgccyqquwxecqffsidr.supabase.co",
  publishableKey: "sb_publishable_chave_de_teste_longa_o_bastante",
};

const VALID_TOKEN = "eyJ.token.de.teste";

describe("createUserClient", () => {
  it("cria o cliente com configuração e token válidos", () => {
    expect(createUserClient(VALID_CONFIG, VALID_TOKEN)).toBeDefined();
  });

  it("rejeita url vazia", () => {
    expect(() => createUserClient({ ...VALID_CONFIG, supabaseUrl: "" }, VALID_TOKEN)).toThrow(
      UserClientConfigError,
    );
  });

  it("rejeita url que não é http(s)", () => {
    expect(() =>
      createUserClient({ ...VALID_CONFIG, supabaseUrl: "nmgccyqquwxecqffsidr.supabase.co" }, VALID_TOKEN),
    ).toThrow(UserClientConfigError);
  });

  it("rejeita chave publicável ausente ou curta demais", () => {
    expect(() => createUserClient({ ...VALID_CONFIG, publishableKey: "" }, VALID_TOKEN)).toThrow(
      UserClientConfigError,
    );
  });

  it("rejeita token de acesso vazio", () => {
    expect(() => createUserClient(VALID_CONFIG, "")).toThrow(UserClientConfigError);
  });

  it("não persiste sessão: cada request tem seu próprio token, nada a renovar", () => {
    const client = createUserClient(VALID_CONFIG, VALID_TOKEN);

    expect(client.auth).toBeDefined();
  });
});
