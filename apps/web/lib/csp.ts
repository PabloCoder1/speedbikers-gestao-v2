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
 * - **`img-src` externo só para as fotos de anúncio**: a miniatura em
 *   `/anuncios` vem de `https://*.mlstatic.com` (a sincronização só grava host
 *   desse domínio), e a de `/anuncios/shopee` dos CDNs de `SHOPEE_IMAGE_HOSTS`
 *   (D-428). Sem `worker-src` nem `frame-src`: conferido que o app não tem
 *   `Worker`, `iframe` nem `EventSource`.
 */

/**
 * Os hosts da foto do anúncio Shopee (`shopee_items.image_url`, D-428) que o
 * `img-src` abre. **NÃO MEDIDOS**: o worker grava a primeira URL de
 * `image_url_list` sem conferir o host, e estes são os CDNs públicos da Shopee
 * Brasil. Por isso `/anuncios/shopee` só desenha `<img>` para estes hosts
 * (`shopeeImageUrl`) — qualquer outro cai no monograma, nunca num quadrado
 * bloqueado. Medir o host real no sandbox e em produção e corrigir aqui.
 */
export const SHOPEE_IMAGE_HOSTS = ["*.susercontent.com", "cf.shopee.com.br"] as const;

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
    // A foto de perfil vem do Storage do Supabase (D-354): a mesma origem que
    // `connect-src` já abre. A miniatura do anúncio vem do CDN do Mercado Livre
    // (`/anuncios`, 20260918150000); a do anúncio Shopee, dos CDNs da Shopee
    // (`/anuncios/shopee`, D-428).
    `img-src 'self' data: blob:${supabase === null ? "" : ` ${supabase.http}`} https://*.mlstatic.com${SHOPEE_IMAGE_HOSTS.map((host) => ` https://${host}`).join("")}`,
    "font-src 'self'",
    `connect-src ${[...new Set(conectar)].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  return diretivas.join("; ");
}
