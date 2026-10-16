/**
 * Tradução da resposta da `api` para uma frase que ajuda quem está enviando.
 *
 * Separado do componente de propósito: é a única parte do upload que tem regra,
 * e regra sem teste é onde a mensagem errada nasce. "Erro 400" não diz a
 * ninguém o que fazer; "esse arquivo já foi enviado antes" diz.
 */

export interface UploadMessage {
  tone: "bad" | "soft";
  text: string;
}

export interface UploadResult {
  /** Preenchido quando há lote para abrir — inclusive no caso duplicado. */
  batchId: string | null;
  message: UploadMessage;
}

function readBatchId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  const value = (payload as Record<string, unknown>).batchId;

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
  invalid_kind: "Tipo de arquivo não reconhecido.",
  unauthorized: "Você não tem permissão para importar. Fale com um administrador.",
  not_configured: "A importação ainda não está configurada neste ambiente.",
};

export function describeUploadResponse(status: number, payload: unknown): UploadResult {
  const batchId = readBatchId(payload);

  // 201 criado, 200 duplicado. Nos dois casos há lote para abrir — o duplicado
  // inclusive é o caso mais útil de abrir, porque mostra a conferência que já
  // existe em vez de deixar a pessoa achando que o envio se perdeu.
  if ((status === 201 || status === 200) && batchId !== null) {
    return { batchId, message: { tone: "soft", text: "Arquivo recebido." } };
  }

  const code = readErrorCode(payload);

  // `rejected` vem com o motivo já escrito para humano pela `api` ("arquivo
  // vazio", "arquivo acima do limite aceito"). Reescrever aqui só criaria duas
  // versões da mesma frase, que divergiriam na primeira mudança.
  if (code === "rejected") {
    const reason = readError(payload)?.message;

    return {
      batchId: null,
      message: {
        tone: "bad",
        text: typeof reason === "string" && reason !== "" ? `Recusado: ${reason}.` : "Arquivo recusado.",
      },
    };
  }

  if (code !== null && Object.hasOwn(BY_CODE, code)) {
    return { batchId: null, message: { tone: "bad", text: BY_CODE[code] ?? "" } };
  }

  if (status === 413) {
    return {
      batchId: null,
      message: { tone: "bad", text: "Arquivo grande demais para o envio direto." },
    };
  }

  if (status >= 500) {
    return {
      batchId: null,
      message: { tone: "bad", text: "O servidor falhou ao receber. Tente de novo em instantes." },
    };
  }

  return {
    batchId: null,
    message: { tone: "bad", text: "Não foi possível enviar o arquivo." },
  };
}
