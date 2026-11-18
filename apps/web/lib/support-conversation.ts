type ConversationDirection = "antes" | "depois";

interface ConversationCursor {
  direction: ConversationDirection;
  occurredAt: string;
  id: string;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseConversationCursor(value: string | string[] | undefined): ConversationCursor | null {
  if (typeof value !== "string") return null;

  const [direction, occurredAt, id, extra] = value.split("|");
  if ((direction !== "antes" && direction !== "depois") ||
      occurredAt === undefined || id === undefined || extra !== undefined || !UUID.test(id)) {
    return null;
  }

  const calendar = TIMESTAMP.exec(occurredAt)?.[1];
  if (calendar === undefined || calendar.startsWith("0000")) return null;
  const date = new Date(`${calendar}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== calendar) return null;

  // Preserva os microssegundos devolvidos pelo PostgREST.
  return { direction, occurredAt, id };
}

export function conversationHref(caseId: string, back: string, cursor?: ConversationCursor): string {
  const params = new URLSearchParams();
  if (back !== "/atendimento") params.set("volta", back);
  if (cursor !== undefined) params.set("mensagens", `${cursor.direction}|${cursor.occurredAt}|${cursor.id}`);

  const query = params.toString();
  return `/atendimento/${caseId}${query === "" ? "" : `?${query}`}#conversa`;
}
