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
  /**
   * Quanto demorou ESTA ida, em milissegundos (D-309).
   *
   * É uma amostra, não uma média, não um p95 e não um SLA — e o rótulo na
   * tela diz isso com todas as letras. A tela já fazia a ida; cronometrá-la
   * não custa leitura nova, e é o único número de latência desta casa que
   * mede o que o nome promete.
   *
   * Nulo quando a resposta não veio: sem resposta não há tempo de resposta.
   */
  latencyMs: number | null;
}

export function apiBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";

  return base === "" ? null : base;
}

export async function fetchApiHealth(): Promise<ApiHealth | null> {
  const base = apiBaseUrl();

  if (base === null) return null;

  /*
    `performance.now()` e não `Date.now()`: o relógio de parede pode saltar
    (ajuste de NTP no meio da ida) e produziria um número negativo ou absurdo
    justamente no caso raro. O monotônico só anda para a frente.
  */
  const inicio = performance.now();

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
      /*
        O tempo é medido DEPOIS de ler o corpo, e isso é deliberado: o que
        interessa a quem olha é "quanto demorou até eu ter a resposta", não
        quanto demorou até o primeiro byte. A diferença aqui é de um JSON de
        três campos.
      */
      latencyMs: Math.round(performance.now() - inicio),
    };
  } catch {
    return null;
  }
}
