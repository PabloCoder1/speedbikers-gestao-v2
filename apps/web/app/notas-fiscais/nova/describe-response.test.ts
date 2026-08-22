import { describe, expect, it } from "vitest";

import { describeUploadResponse } from "./describe-response";

describe("resposta do upload de NF-e", () => {
  it("201 abre o documento criado", () => {
    const result = describeUploadResponse(201, { documentId: "d-1", duplicate: false });

    expect(result.documentId).toBe("d-1");
  });

  it("nota repetida abre a conferência que já existe", () => {
    const result = describeUploadResponse(200, { documentId: "d-1", duplicate: true });

    expect(result.documentId).toBe("d-1");
  });

  it("repassa o motivo da recusa escrito pela api", () => {
    const result = describeUploadResponse(400, {
      error: { code: "rejected", message: "arquivo acima do limite aceito" },
    });

    expect(result.documentId).toBeNull();
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

  it("200 sem documentId não é sucesso", () => {
    expect(describeUploadResponse(200, {}).documentId).toBeNull();
    expect(describeUploadResponse(200, null).documentId).toBeNull();
    expect(describeUploadResponse(201, "texto").documentId).toBeNull();
  });
});
