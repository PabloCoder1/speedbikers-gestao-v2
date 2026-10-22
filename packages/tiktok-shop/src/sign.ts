import { createHmac } from "node:crypto";

/**
 * A assinatura do TikTok Shop Open API (D-645) — P`sign-your-api-request`,
 * conferida em 22/10/2026 com o exemplo oficial (`docs/TIKTOK_SHOP.md` §3):
 *
 * 1. os parâmetros de query, MENOS `sign` e `access_token` (o `shop_cipher`
 *    entra), em ordem alfabética, concatenados como `{chave}{valor}`;
 * 2. o caminho (com a versão) na frente;
 * 3. o corpo no fim, nos BYTES exatos enviados, quando o `content-type` não é
 *    `multipart/form-data` — quem chama assina a mesma string que envia;
 * 4. `app_secret` + string + `app_secret`;
 * 5. HMAC-SHA256 com a chave `app_secret`, em hexadecimal minúsculo.
 */

const FORA_DA_ASSINATURA = new Set(["sign", "access_token"]);

export function signBaseString(path: string, query: Readonly<Record<string, string>>, body?: string): string {
  const parametros = Object.keys(query)
    .filter((chave) => !FORA_DA_ASSINATURA.has(chave))
    .sort()
    .map((chave) => `${chave}${query[chave] ?? ""}`)
    .join("");

  return `${path}${parametros}${body ?? ""}`;
}

export function sign(appSecret: string, path: string, query: Readonly<Record<string, string>>, body?: string): string {
  return createHmac("sha256", appSecret)
    .update(`${appSecret}${signBaseString(path, query, body)}${appSecret}`)
    .digest("hex");
}
