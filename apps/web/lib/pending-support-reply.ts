import type { Tables } from "@sb/db";

export const PENDING_SUPPORT_REPLY_FIELDS =
  "status, requested_by, client_request_id, final_text, suggested_text, dispatch_queue, dispatch_started_at";

export type StoredSupportReply = Pick<
  Tables<"support_reply_attempts">,
  "status" | "requested_by" | "client_request_id" | "final_text" | "suggested_text" | "dispatch_queue" | "dispatch_started_at"
>;

export interface PendingSupportReply {
  clientRequestId: string;
  text: string;
  suggestedText: string | null;
}

export function pendingSupportReply(
  attempts: readonly StoredSupportReply[],
  viewerId: string | null,
): PendingSupportReply | null {
  if (viewerId === null) return null;

  const attempt = attempts.find((row) =>
    row.requested_by === viewerId &&
    row.status === "PENDING" &&
    row.dispatch_queue !== null &&
    row.dispatch_started_at === null,
  );

  return attempt === undefined ? null : {
    clientRequestId: attempt.client_request_id,
    text: attempt.final_text,
    suggestedText: attempt.suggested_text,
  };
}
