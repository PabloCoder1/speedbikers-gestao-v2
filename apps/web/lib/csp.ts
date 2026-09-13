/**
 * A CONTENT SECURITY POLICY da `web`, com nonce por requisição (D-331).
 *
 * D-329 pôs só `frame-ancestors 'none'` numa CSP estática e deixou o resto para
 * uma fatia própria, porque `script-src` sem nonce quebraria os scripts inline
 * do Next. Esta é a fatia. O desenho segue o guia do Next 16 empacotado em
 * `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`, e
 * cada desvio dele foi MEDIDO nesta aplicação antes de ser escrito:
 *
 * - **`style-src` leva `'unsafe-inline'`.** O guia usa nonce também para estilo,
 *   mas nonce não autoriza ATRIBUTO `style` — e a aplicação tem 999 `style={{…}}`
 *   que viram atributo no HTML. Nonce em `style-src` desmontaria a tela inteira.
 *   O ganho que importa é `script-src`, que é por onde entra XSS.
 * - **Sem `upgrade-insecure-requests`.** Ele trocaria `http://127.0.0.1:54321`
 *   (o Supabase local do e2e) por `https` e quebraria a suíte; em produção a
 *   Vercel já força HTTPS com HSTS e `preload`.
 * - **`connect-src` sai das variáveis de ambiente**, e não de uma lista escrita:
 *   o navegador fala com o Supabase (HTTPS e o WebSocket do Realtime, que os
 *   toasts de notificação usam) e com a `api` (`NEXT_PUBLIC_API_URL`, lida por dez
 *   componentes de cliente). O mesmo código serve o local e o Dev.
 * - **Sem `img-src` externo, `worker-src`, `frame-src`**: conferido que o app não
 *   tem `<img>`, `Worker`, `blob:` criado, `iframe` nem `EventSource`.
 */

/** Um valor imprevisível e único por requisição — é o que o atacante teria de adivinhar. */
export function gerarNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * A origem de uma URL, e a mesma origem no esquema de WebSocket.
 *
 * Devolve `null` para URL vazia ou inválida: uma variável ausente não pode virar
 * a string `'null'` dentro da política, nem derrubar a requisição.
 */
function origens(url: string | undefined): { http: string; ws: string } | null {
  if (url === undefined || url.trim() === "") return null;

  try {
    const { origin, protocol } = new URL(url);

    if (protocol !== "http:" && protocol !== "https:") return null;

    return { http: origin, ws: origin.replace(/^http/, "ws") };
  } catch {
    return null;
  }
}

export function montarCsp({
  nonce,
  supabaseUrl,
  apiUrl,
  dev,
}: {
  nonce: string;
  supabaseUrl: string | undefined;
  apiUrl: string | undefined;
  /** `next dev` precisa de `'unsafe-eval'` (pilhas de erro do React) e do WebSocket do HMR. */
  dev: boolean;
}): string {
  const supabase = origens(supabaseUrl);
  const api = origens(apiUrl);

  const conectar = [
    "'self'",
    ...(supabase === null ? [] : [supabase.http, supabase.ws]),
    ...(api === null ? [] : [api.http]),
    ...(dev ? ["ws:"] : []),
  ];

  const diretivas = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${[...new Set(conectar)].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  return diretivas.join("; ");
}
