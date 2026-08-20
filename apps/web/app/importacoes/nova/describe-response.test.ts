import { describe, expect, it } from "vitest";

import { describeUploadResponse } from "./describe-response";

describe("resposta do upload", () => {
  it("201 abre o lote criado", () => {
    const result = describeUploadResponse(201, { batchId: "b-1", duplicate: false });

    expect(result.batchId).toBe("b-1");
  });

  it("arquivo repetido abre a conferência que já existe", () => {
    // O caso mais útil de abrir: sem isso a pessoa reenvia achando que se
    // perdeu, e o `content_hash` UNIQUE recusa de novo, num laço.
    const result = describeUploadResponse(200, { batchId: "b-1", duplicate: true });

    expect(result.batchId).toBe("b-1");
  });

  it("repassa o motivo da recusa escrito pela api", () => {
    const result = describeUploadResponse(400, {
      error: { code: "rejected", message: "arquivo acima do limite aceito" },
    });

    expect(result.batchId).toBeNull();
    expect(result.message.text).toContain("arquivo acima do limite aceito");
  });

  it("recusa sem motivo ainda produz frase legível", () => {
    const result = describeUploadResponse(400, { error: { code: "rejected" } });

    expect(result.message.text).toBe("Arquivo recusado.");
  });

  it("falta de permissão diz o que fazer", () => {
    const result = describeUploadResponse(403, { error: { code: "unauthorized" } });

    expect(result.message.text).toContain("administrador");
  });

  it("5xx convida a tentar de novo; 4xx desconhecido não", () => {
    expect(describeUploadResponse(502, null).message.text).toContain("Tente de novo");
    expect(describeUploadResponse(418, null).message.text).toBe("Não foi possível enviar o arquivo.");
  });

  it("200 sem batchId não é sucesso", () => {
    // Resposta truncada ou corpo que não é JSON não pode virar navegação para
    // `/importacoes/undefined`.
    expect(describeUploadResponse(200, {}).batchId).toBeNull();
    expect(describeUploadResponse(200, null).batchId).toBeNull();
    expect(describeUploadResponse(201, "texto").batchId).toBeNull();
  });
});
