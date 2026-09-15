import { NextResponse } from "next/server";

const NAMES = new Set(["TTFB", "LCP", "CLS", "INP"]);

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return NextResponse.json({ ok: false }, { status: 400 });
  const data = body as { name?: unknown; value?: unknown; path?: unknown };
  if (typeof data.name !== "string" || !NAMES.has(data.name) || typeof data.value !== "number" || !Number.isFinite(data.value) || typeof data.path !== "string" || !data.path.startsWith("/")) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  // eslint-disable-next-line no-console -- server-side telemetry sink
  console.info("web_vital", { name: data.name, value: data.value, path: data.path.slice(0, 120) });
  return NextResponse.json({ ok: true }, { status: 202 });
}
