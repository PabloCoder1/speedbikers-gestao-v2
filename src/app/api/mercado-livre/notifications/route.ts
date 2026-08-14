import { NextResponse } from "next/server";

import { ingestMercadoLivreNotification } from "@/features/ml-sync/ingest-mercado-livre-notification";

const MAX_BODY_BYTES = 64 * 1024;

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  try {
    await ingestMercadoLivreNotification({ rawBody });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(
      "Mercado Livre notification enqueue failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "notification_enqueue_failed" }, { status: 500 });
  }
}
