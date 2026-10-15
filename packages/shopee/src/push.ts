import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Push da Shopee (D-453) — o "Push Mechanism" (webhook), conferido no guia
 * "Push Mechanism notifications" (developer-guide/18) e nas páginas de cada
 * push em 14/10/2026.
 *
 * - A Shopee manda um POST ao endereço cadastrado no Console; o cabeçalho
 *   `Authorization` traz o HMAC-SHA256 (hex) da chave do parceiro sobre
 *   `<endereço>|<corpo cru>` — o corpo como chegou, sem reserializar.
 * - Responder 2xx com corpo VAZIO em até 3 s; senão a Shopee repete (300 s,
 *   1800 s, 10800 s) e a taxa de sucesso baixa (abaixo de 30% com mais de 600
 *   pushes em 6 h, a assinatura é desligada).
 * - Sem ordem garantida e com repetição: o push só AVISA que algo mudou — quem
 *   lê o dado é a API, pelo job de sempre.
 */

/** `order_status_push`: o pedido mudou de situação (`data.ordersn`, `data.status`). */
export const PUSH_ORDER_STATUS = 3;
/** `return_updates_push`: a devolução mudou (`data.order_sn`, `data.return_sn`). */
export const PUSH_RETURN_UPDATES = 29;
/** `shop_authorization_canceled_push`: os exemplos da documentação se contradizem no formato. */
export const PUSH_AUTHORIZATION_CANCELED = 2;

/** Número, ou texto só com dígitos: o `return_updates_push` de teste (15/10) mandou `"code": "29"`. */
const inteiro = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]);

/** O envelope comum: `code` sempre; `shop_id` nos pushes de loja; o resto, por push. */
export const shopeePushSchema = z.looseObject({
  code: inteiro,
  shop_id: inteiro.optional(),
  timestamp: inteiro.optional(),
  data: z.unknown().optional(),
});

export type ShopeePush = z.infer<typeof shopeePushSchema>;

export function signPush(partnerKey: string, url: string, rawBody: string): string {
  return createHmac("sha256", partnerKey).update(`${url}|${rawBody}`).digest("hex");
}

/** O `Authorization` confere com o endereço cadastrado e o corpo cru? Comparação em tempo constante. */
export function verifyPushSignature(partnerKey: string, url: string, rawBody: string, authorization: string | undefined): boolean {
  if (authorization === undefined || !/^[0-9a-f]{64}$/i.test(authorization)) return false;

  const esperado = Buffer.from(signPush(partnerKey, url, rawBody), "hex");
  const recebido = Buffer.from(authorization.toLowerCase(), "hex");

  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}
