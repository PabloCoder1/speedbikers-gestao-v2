/**
 * Destino seguro depois do login.
 *
 * O `next` é escrito pelo proxy (`apps/web/proxy.ts`) sempre como caminho
 * interno, mas quem o LÊ é o formulário de login, a partir da URL do
 * navegador — ou seja, qualquer pessoa pode montar `/login?next=...` com o
 * que quiser e mandar o link para outra. Sem esta checagem, um `next`
 * absoluto levaria a vítima para fora do sistema logo depois de digitar a
 * senha, na tela em que ela está mais propensa a confiar no que vê.
 *
 * Aceita **somente** caminho interno: precisa começar com uma barra e não
 * pode começar com duas. `//evil.com` é URL protocolo-relativa — o navegador
 * a trata como host externo, e é a forma mais fácil de passar por uma
 * checagem ingênua que só olha o primeiro caractere.
 *
 * A query string é preservada de propósito: é ela que carrega o filtro da
 * tela de origem (D-090).
 *
 * Olhar os primeiros caracteres não basta: o parser de URL descarta TAB e
 * quebra de linha em qualquer posição, e `/\t/evil.com` vira `//evil.com`
 * depois da checagem (auditoria de 2026-09-28). Por isso o destino é
 * resolvido como o navegador resolveria e só passa se continuar na origem.
 */
const ORIGEM_DE_REFERENCIA = "https://origem.invalid";

export function safeNext(next: string | null | undefined): string {
  if (next === null || next === undefined) {
    return "/";
  }

  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/";
  }

  // `\` é normalizado para `/` por alguns navegadores em contexto de URL,
  // então `/\evil.com` também precisa cair fora.
  if (next.startsWith("/\\")) {
    return "/";
  }

  let destino: URL;

  try {
    destino = new URL(next, ORIGEM_DE_REFERENCIA);
  } catch {
    return "/";
  }

  if (destino.origin !== ORIGEM_DE_REFERENCIA) {
    return "/";
  }

  return `${destino.pathname}${destino.search}${destino.hash}`;
}
