/**
 * Tradução da resposta da `api` para uma frase que ajuda quem está enviando.
 *
 * Mesmo raciocínio de `apps/web/app/importacoes/nova/describe-response.ts`:
 * separado do componente porque é a única parte do upload que tem regra.
 */

export interface UploadMessage {
  tone: "bad" | "soft";
  text: string;
}

export interface UploadResult {
  /** Preenchido quando há documento para abrir — inclusive no caso duplicado. */
  documentId: string | null;
  message: UploadMessage;
}

function readDocumentId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const value = (payload as Record<string, unknown>).documentId;

  return typeof value === "string" && value !== "" ? value : null;
}

function readError(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;

  const error = (payload as Record<string, unknown>).error;

  return typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
}

function readErrorCode(payload: unknown): string | null {
  const code = readError(payload)?.code;

  return typeof code === "string" ? code : null;
}

const BY_CODE: Record<string, string> = {
  file_required: "Escolha um arquivo antes de enviar.",
  unauthorized: "Você não tem permissão para importar NF-e. Fale com um administrador.",
  not_configured: "O envio de NF-e ainda não está configurado neste ambiente.",
};

export function describeUploadResponse(status: number, payload: unknown): UploadResult {
  const documentId = readDocumentId(payload);

  // 201 criado, 200 duplicado. Nos dois casos há documento para abrir — o
  // duplicado inclusive é o caso mais útil de abrir, porque mostra a
  // conferência que já existe em vez de deixar a pessoa achando que o envio
  // se perdeu.
  if ((status === 201 || status === 200) && documentId !== null) {
    return { documentId, message: { tone: "soft", text: "Arquivo recebido." } };
  }

  const code = readErrorCode(payload);

  if (code === "rejected") {
    const reason = readError(payload)?.message;

    return {
      documentId: null,
      message: {
        tone: "bad",
        text: typeof reason === "string" && reason !== "" ? `Recusado: ${reason}.` : "Arquivo recusado.",
      },
    };
  }

  if (code !== null && Object.hasOwn(BY_CODE, code)) {
    return { documentId: null, message: { tone: "bad", text: BY_CODE[code] ?? "" } };
  }

  if (status === 413) {
    return {
      documentId: null,
      message: { tone: "bad", text: "Arquivo grande demais para o envio direto." },
    };
  }

  if (status >= 500) {
    return {
      documentId: null,
      message: { tone: "bad", text: "O servidor falhou ao receber. Tente de novo em instantes." },
    };
  }

  return {
    documentId: null,
    message: { tone: "bad", text: "Não foi possível enviar o arquivo." },
  };
}
