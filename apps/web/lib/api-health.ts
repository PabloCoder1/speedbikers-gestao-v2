/**
 * Lê o `/health` da API no Cloud Run — extraído de `app/saude/page.tsx` em
 * D-231, porque a Central de Integrações precisa da MESMA leitura e um
 * formato só. Qualquer falha — rede, timeout, resposta estranha — vira
 * `null`, e o chamador transforma isso em "não medido" com o motivo. Nunca
 * lança: uma API fora do ar não pode derrubar a tela que existe para mostrar
 * que ela está fora do ar.
 */
export interface ApiHealth {
  commit: string | null;
  startedAt: string | null;
}

export function apiBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";

  return base === "" ? null : base;
}

export async function fetchApiHealth(): Promise<ApiHealth | null> {
  const base = apiBaseUrl();

  if (base === null) return null;

  try {
    const response = await fetch(`${base}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as { commit?: unknown; startedAt?: unknown };

    return {
      commit: typeof body.commit === "string" ? body.commit : null,
      startedAt: typeof body.startedAt === "string" ? body.startedAt : null,
    };
  } catch {
    return null;
  }
}
