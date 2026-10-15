import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import {
  PUSH_AUTHORIZATION_CANCELED,
  PUSH_ORDER_STATUS,
  PUSH_RETURN_UPDATES,
  shopeePushSchema,
  verifyPushSignature,
  type ShopeeEnvironment,
} from "@sb/shopee";

import type { Enqueuer } from "./enqueue.js";

/**
 * Push da Shopee (D-453): o aviso de que um pedido ou uma devolução mudou
 * ANTECIPA a sincronização da loja — quem lê o dado continua sendo o job de
 * sempre (`shopee.orders.sync`, `shopee.returns.sync`), pela API. O gatilho
 * de hora em hora segue como rede: o push não tem entrega garantida.
 *
 * - Assinatura: HMAC da chave do parceiro sobre `<endereço cadastrado>|<corpo
 *   cru>`. Push sem assinatura válida é IGNORADO, mas recebe 2xx: a
 *   verificação do endereço no Console não diz se vem assinada, e responder
 *   erro só baixaria a taxa de sucesso que a Shopee usa para desligar a
 *   assinatura. Nada é feito com ele.
 * - Os avisos de uma loja numa janela de 5 minutos viram UMA leitura, no fim
 *   da janela (a mesma chave de deduplicação com atraso até o fim dela): o
 *   primeiro aviso agenda, os seguintes caem na mesma tarefa, nenhum se perde
 *   e a carga fica limitada a 12 leituras por hora por loja.
 * - Autorização cancelada (código 2) só vai para o log: os exemplos da
 *   documentação se contradizem no formato (`shop_id`, `shopid`, listas), e
 *   a renovação do token já marca a loja quando a Shopee recusa.
 */

/** A janela que junta os avisos de uma loja numa leitura. */
export const PUSH_JANELA_S = 300;

export interface ShopeePushDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  environment: ShopeeEnvironment;
  partnerKey: string;
  /**
   * Chave de assinatura do push, se a Shopee usar uma diferente da do
   * parceiro (os pushes de teste de 15/10 vieram assinados e não conferiram
   * com a de teste). Tentada antes da do parceiro.
   */
  pushKey?: string;
  /** O endereço EXATO cadastrado no Console: entra na assinatura. */
  pushUrl: string;
  now?: () => Date;
}

export type ShopeePushOutcome =
  | { status: "invalid_signature" }
  | { status: "invalid_payload"; reason: string }
  | { status: "ignored"; code: number; reason: string }
  | { status: "enqueued"; code: number; jobType: string; deduplicated: boolean }
  // Falha passageira ao ler a loja ou enfileirar: a Shopee repete.
  | { status: "unavailable"; reason: string };

const JOB_DO_PUSH: Record<number, { jobType: string; prefixo: string }> = {
  [PUSH_ORDER_STATUS]: { jobType: "shopee.orders.sync", prefixo: "shopee-orders-push" },
  [PUSH_RETURN_UPDATES]: { jobType: "shopee.returns.sync", prefixo: "shopee-returns-push" },
};

/**
 * Os endereços que valem na assinatura: o cadastrado e as variações que só
 * mudam a forma (barra no fim, http no lugar de https). Todas exigem a chave
 * do parceiro — aceitar a variação não enfraquece nada, e evita perder push
 * por uma barra digitada a mais no Console.
 */
export function enderecosDoPush(pushUrl: string): { nome: string; url: string }[] {
  const semBarra = pushUrl.replace(/\/+$/, "");
  const outroEsquema = semBarra.startsWith("https://") ? `http://${semBarra.slice(8)}` : `https://${semBarra.replace(/^http:\/\//, "")}`;

  return [
    { nome: "cadastrado", url: pushUrl },
    { nome: "sem_barra", url: semBarra },
    { nome: "com_barra", url: `${semBarra}/` },
    { nome: "outro_esquema", url: outroEsquema },
  ].filter((e, i, todos) => todos.findIndex((o) => o.url === e.url) === i);
}

/**
 * O que dá para dizer de um push recusado SEM expor a assinatura nem o
 * corpo: se o cabeçalho veio, o formato e o tamanho dele, o tamanho do corpo,
 * as chaves e o código. Os nomes evitam as palavras que a redação de log
 * apaga (`authorization`, `token`…) — `has_authorization` saía `[REDACTED]`.
 */
function diagnosticoDaRecusa(input: { rawBody: string; authorization: string | undefined }): Record<string, unknown> {
  let chaves: string[] | null = null;
  let code: unknown = null;

  try {
    const corpo = JSON.parse(input.rawBody) as unknown;

    if (corpo !== null && typeof corpo === "object" && !Array.isArray(corpo)) {
      chaves = Object.keys(corpo).slice(0, 12);
      code = (corpo as { code?: unknown }).code ?? null;
    }
  } catch {
    chaves = null;
  }

  const cabecalho = input.authorization;

  return {
    assinatura_presente: cabecalho !== undefined,
    assinatura_tamanho: cabecalho?.length ?? 0,
    assinatura_formato: cabecalho === undefined ? null : /^[0-9a-f]{64}$/i.test(cabecalho) ? "hex64" : /^\s|\s$/.test(cabecalho) ? "hex_com_espaco" : "outro",
    corpo_bytes: Buffer.byteLength(input.rawBody, "utf8"),
    corpo_chaves: chaves,
    code,
  };
}

export async function receiveShopeePush(
  deps: ShopeePushDeps,
  input: { rawBody: string; authorization: string | undefined },
): Promise<ShopeePushOutcome> {
  const cabecalho = input.authorization?.trim();
  // O corpo exato e, por garantia, sem a quebra de linha do fim (o mesmo
  // conteúdo; a assinatura continua exigindo a chave do parceiro).
  const corpos = [...new Set([input.rawBody, input.rawBody.replace(/\s+$/, "")])];
  const chaves = deps.pushKey === undefined ? [deps.partnerKey] : [deps.pushKey, deps.partnerKey];
  const endereco = enderecosDoPush(deps.pushUrl).find((e) =>
    chaves.some((chave) => corpos.some((corpo) => verifyPushSignature(chave, e.url, corpo, cabecalho))),
  );

  if (endereco === undefined) {
    deps.logger.warn("shopee_push_signature_rejected", {
      ...diagnosticoDaRecusa(input),
      // AMOSTRA TEMPORÁRIA (15/10): o corpo cru e a assinatura recebida, para
      // achar offline a chave e o texto que a Shopee usa. Não é segredo — a
      // assinatura não revela a chave, e o push não traz dado de comprador
      // (loja, pedido, devolução). Sai quando a assinatura fechar.
      amostra_corpo: input.rawBody.slice(0, 2000),
      amostra_assinatura: cabecalho ?? null,
    });

    return { status: "invalid_signature" };
  }

  if (endereco.nome !== "cadastrado") {
    // Confere, mas com outra forma do endereço: o Console tem algo diferente
    // de SHOPEE_PUSH_URL. Funciona; o aviso é para acertar a configuração.
    deps.logger.warn("shopee_push_url_variant", { variante: endereco.nome });
  }

  let corpo: unknown;

  try {
    corpo = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { status: "invalid_payload", reason: "corpo não é JSON" };
  }

  const parsed = shopeePushSchema.safeParse(corpo);

  if (!parsed.success) {
    return { status: "invalid_payload", reason: "push sem code" };
  }

  const push = parsed.data;

  if (push.code === PUSH_AUTHORIZATION_CANCELED) {
    deps.logger.warn("shopee_push_authorization_canceled", { code: push.code, shop_id: push.shop_id ?? null, data: push.data ?? null });

    return { status: "ignored", code: push.code, reason: "autorização cancelada: só registrada" };
  }

  const job = JOB_DO_PUSH[push.code];

  if (job === undefined) {
    deps.logger.info("shopee_push_ignored", { code: push.code, shop_id: push.shop_id ?? null });

    return { status: "ignored", code: push.code, reason: "push sem ação" };
  }

  if (push.shop_id === undefined) {
    return { status: "invalid_payload", reason: "push de loja sem shop_id" };
  }

  const lida = await deps.db
    .from("shopee_shops")
    .select("id, organization_id, status")
    .eq("environment", deps.environment)
    .eq("shop_id", push.shop_id)
    .maybeSingle();

  if (lida.error !== null) {
    deps.logger.error("shopee_push_shop_lookup_failed", { code: push.code, shop_id: push.shop_id, reason: lida.error.message });

    return { status: "unavailable", reason: lida.error.message };
  }

  const loja = lida.data;

  if (loja?.status !== "CONNECTED") {
    deps.logger.info("shopee_push_ignored", {
      code: push.code,
      shop_id: push.shop_id,
      motivo: loja === null ? "loja desconhecida" : "loja não conectada",
    });

    return { status: "ignored", code: push.code, reason: loja === null ? "loja desconhecida" : "loja não conectada" };
  }

  const agoraS = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const fimDaJanela = (Math.floor(agoraS / PUSH_JANELA_S) + 1) * PUSH_JANELA_S;

  try {
    const result = await deps.enqueuer.enqueue({
      jobType: job.jobType,
      organizationId: loja.organization_id,
      dedupeKey: `${job.prefixo}:${loja.id}:${String(fimDaJanela)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
      delaySeconds: fimDaJanela - agoraS,
    });

    deps.logger.info("shopee_push_enqueued", {
      code: push.code,
      shop_id: push.shop_id,
      shopee_shop_id: loja.id,
      job_type: job.jobType,
      deduplicated: result.deduplicated,
    });

    return { status: "enqueued", code: push.code, jobType: job.jobType, deduplicated: result.deduplicated };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha ao enfileirar";

    deps.logger.error("shopee_push_enqueue_failed", { code: push.code, shop_id: push.shop_id, reason });

    return { status: "unavailable", reason };
  }
}
