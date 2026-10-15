import { NextResponse } from "next/server";

const NAMES = new Set(["TTFB", "LCP", "CLS", "INP"]);

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return NextResponse.json({ ok: false }, { status: 400 });
  const data = body as { name?: unknown; value?: unknown; path?: unknown; softNav?: unknown };
  if (typeof data.name !== "string" || !NAMES.has(data.name) || typeof data.value !== "number" || !Number.isFinite(data.value) || typeof data.path !== "string" || !data.path.startsWith("/")) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (data.softNav !== undefined && typeof data.softNav !== "boolean") return NextResponse.json({ ok: false }, { status: 400 });
  // `softNav` só vem do reporter da D-507: aba aberta antes do deploy manda sem ele, e a linha sem o
  // campo é do lado de antes do corte (rota de quando a aba se escondeu, D-506).
  const softNav = typeof data.softNav === "boolean" ? { softNav: data.softNav } : {};
  // eslint-disable-next-line no-console -- server-side telemetry sink
  console.info("web_vital", { name: data.name, value: data.value, path: data.path.slice(0, 120), ...softNav });
  return NextResponse.json({ ok: true }, { status: 202 });
}
