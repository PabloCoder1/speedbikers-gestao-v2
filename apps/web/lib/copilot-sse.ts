/**
 * Parser incremental dos eventos SSE enviados por `POST /v1/copilot/chat` (D-745).
 *
 * Extraído de `apps/web/app/(app)/copiloto/chat.tsx` para ser testável sem DOM
 * e garantir que eventos no fim do stream sem `\n\n` final ou com CRLF (`\r\n`)
 * não sejam descartados em silêncio ao encerrar a leitura.
 */

export type CopilotChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "done"; toolsUsed: string[] }
  | { type: "error"; message: string };

function lerChunk(chunk: string): CopilotChatEvent | null {
  const dataLine = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");

  if (dataLine.length === 0) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(dataLine);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate.type === "text" && typeof candidate.delta === "string") {
    return { type: "text", delta: candidate.delta };
  }

  if (candidate.type === "tool" && typeof candidate.name === "string") {
    return { type: "tool", name: candidate.name };
  }

  if (candidate.type === "done" && Array.isArray(candidate.toolsUsed)) {
    return {
      type: "done",
      toolsUsed: candidate.toolsUsed.filter((item): item is string => typeof item === "string"),
    };
  }

  if (candidate.type === "error" && typeof candidate.message === "string") {
    return { type: "error", message: candidate.message };
  }

  return null;
}

/**
 * Consome eventos completos de um buffer SSE.
 *
 * Com `final = false`, devolve o último trecho incompleto em `rest` para o próximo
 * pedaço do stream. Com `final = true` (EOF após `decoder.decode()`), também
 * consome o que restou no buffer sem exigir `\n\n` no fim do stream.
 */
export function extrairEventosSse(
  buffer: string,
  final = false,
): { events: CopilotChatEvent[]; rest: string } {
  const normalizado = buffer.replace(/\r\n/g, "\n");
  const partes = normalizado.split("\n\n");
  const rest = final ? "" : (partes.pop() ?? "");
  const events: CopilotChatEvent[] = [];

  for (const chunk of partes) {
    const event = lerChunk(chunk);

    if (event !== null) {
      events.push(event);
    }
  }

  return { events, rest };
}
