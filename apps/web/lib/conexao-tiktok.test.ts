import { describe, expect, it } from "vitest";

import { avisoDaConexaoTiktok } from "./conexao-tiktok";

describe("avisoDaConexaoTiktok (D-652, C-86)", () => {
  it("o 503 é o TikTok ainda desligado: aviso neutro, sem erro", () => {
    expect(avisoDaConexaoTiktok(503)).toEqual({ tom: "neutro", texto: "O TikTok Shop ainda não está disponível." });
  });

  it("sessão, papel e recusa têm o texto próprio, como erro", () => {
    expect(avisoDaConexaoTiktok(401)).toMatchObject({ tom: "erro", texto: "Sua sessão expirou. Entre de novo." });
    expect(avisoDaConexaoTiktok(403)).toMatchObject({ tom: "erro", texto: "Só um administrador conecta a loja do TikTok Shop." });
    expect(avisoDaConexaoTiktok(409).tom).toBe("erro");
  });

  it("qualquer outro código cai no genérico, sem inventar causa", () => {
    for (const status of [400, 500, 502]) {
      expect(avisoDaConexaoTiktok(status)).toEqual({ tom: "erro", texto: "Não foi possível iniciar a conexão." });
    }
  });
});
