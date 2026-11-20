import type { AdminClient, TablesInsert } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Caller } from "./auth.js";

/**
 * Saída Manual (D-766) — a "Criar Saída" do UpSeller: armazém, tipo de saída,
 * observação e uma lista de SKUs com quantidade, gravada de uma vez.
 *
 * Sem migration, de propósito (o caminho de migration para a VM de produção
 * ainda não está reconciliado, `infra/vm/README.md`). Cada linha é um
 * `AJUSTE_MANUAL` comum, o mesmo tipo do ajuste por SKU
 * (`create_manual_stock_adjustment`): com `created_by` (quem deu a saída) e
 * `reason` (o tipo e a observação), as duas exigências do CHECK. O que a junta
 * numa saída só é a origem: `source_type = 'SAIDA_MANUAL'` e `source_id` = o
 * identificador da saída, gerado pelo navegador.
 *
 * Tudo ou nada: as linhas vão num único `upsert`, um único INSERT no Postgres.
 * E sem duplicar: a chave de idempotência é `saida-manual:<saída>:<SKU>`, então
 * o reenvio da mesma saída (clique duplo, rede que caiu depois de gravar) não
 * baixa duas vezes.
 */

export const TIPOS_DE_SAIDA_MANUAL = {
  OUTROS: "Outros",
  PERDAS: "Perdas",
  TRANSFERENCIAS: "Transferências",
} as const;

export type TipoDeSaidaManual = keyof typeof TIPOS_DE_SAIDA_MANUAL;

/**
 * `stock_movements.reason` aceita até 500 caracteres; o prefixo
 * ("Saída manual · Transferências · ") ocupa ~33. A observação fica em 450.
 */
export const OBSERVACAO_MAX = 450;
export const MAX_ITENS = 300;
export const MAX_QUANTIDADE = 1_000_000;
/** Lote de UUIDs no `.in()` do PostgREST (~3,7 KB/GET) para evitar HTTP 414 com até 300 SKUs (D-770). */
const SKU_LOOKUP_CHUNK = 100;

export const manualExitSchema = z.object({
  requestId: z.uuid(),
  tipo: z.enum(["OUTROS", "PERDAS", "TRANSFERENCIAS"]),
  observacao: z.string().max(OBSERVACAO_MAX),
  itens: z
    .array(
      z.object({
        skuId: z.uuid(),
        quantidade: z.number().int().positive().max(MAX_QUANTIDADE),
      }),
    )
    .min(1)
    .max(MAX_ITENS),
});

export type ManualExitInput = z.infer<typeof manualExitSchema>;

export interface ManualExitDeps {
  db: AdminClient;
  logger: Logger;
  now?: () => Date;
}

export type ManualExitOutcome =
  | { status: "applied"; requestId: string; itens: number; unidades: number }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

/** "Saída manual · Perdas · caixa molhada no depósito". */
export function motivoDaSaidaManual(tipo: TipoDeSaidaManual, observacao: string): string {
  const obs = observacao.trim().replace(/\s+/g, " ").slice(0, OBSERVACAO_MAX);

  return ["Saída manual", TIPOS_DE_SAIDA_MANUAL[tipo], ...(obs === "" ? [] : [obs])].join(" · ");
}

export function linhasDaSaidaManual(
  caller: Caller,
  input: ManualExitInput,
  agora: Date,
): TablesInsert<"stock_movements">[] {
  const motivo = motivoDaSaidaManual(input.tipo, input.observacao);

  return input.itens.map((item) => ({
    organization_id: caller.organizationId,
    sku_id: item.skuId,
    location_kind: "LOCAL",
    qty_delta: -item.quantidade,
    movement_type: "AJUSTE_MANUAL",
    reason: motivo,
    created_by: caller.userId,
    source_type: "SAIDA_MANUAL",
    source_id: input.requestId,
    idempotency_key: `saida-manual:${input.requestId}:${item.skuId}`,
    occurred_at: agora.toISOString(),
  }));
}

export async function registerManualExit(
  deps: ManualExitDeps,
  caller: Caller,
  input: ManualExitInput,
): Promise<ManualExitOutcome> {
  const ids = input.itens.map((item) => item.skuId);

  // A tela soma o mesmo SKU numa linha só; duas linhas do mesmo SKU dariam duas
  // chaves de idempotência iguais, e uma delas seria descartada em silêncio.
  if (new Set(ids).size !== ids.length) {
    return { status: "rejected", reason: "o mesmo SKU aparece mais de uma vez — junte as quantidades numa linha" };
  }

  // A escrita é com a chave de serviço, que ignora a RLS: a organização do SKU
  // é conferida aqui, contra a do usuário autenticado. Fatiado em lotes de 100
  // UUIDs para não estourar o limite de URL do proxy com até 300 SKUs (D-770).
  const lotes: string[][] = [];

  for (let inicio = 0; inicio < ids.length; inicio += SKU_LOOKUP_CHUNK) {
    lotes.push(ids.slice(inicio, inicio + SKU_LOOKUP_CHUNK));
  }

  const resultados = await Promise.all(
    lotes.map((lote) =>
      deps.db.from("skus").select("id").eq("organization_id", caller.organizationId).in("id", lote),
    ),
  );

  const encontrados = new Set<string>();

  for (const resposta of resultados) {
    if (resposta.error !== null) {
      return { status: "failed", reason: "não foi possível conferir os SKUs" };
    }

    for (const linha of resposta.data) {
      encontrados.add(linha.id);
    }
  }

  if (encontrados.size !== ids.length) {
    return { status: "rejected", reason: "um ou mais SKUs não existem nesta organização" };
  }

  const linhas = linhasDaSaidaManual(caller, input, deps.now?.() ?? new Date());

  // `ignoreDuplicates` = ON CONFLICT DO NOTHING: o ledger é append-only (D-019),
  // e o reenvio da mesma saída não pode nem duplicar nem reescrever.
  const gravado = await deps.db
    .from("stock_movements")
    .upsert(linhas, { onConflict: "idempotency_key", ignoreDuplicates: true });

  if (gravado.error !== null) {
    deps.logger.error("manual_exit_failed", { request_id: input.requestId, reason: gravado.error.message });

    return { status: "failed", reason: "não foi possível gravar a saída" };
  }

  const unidades = input.itens.reduce((soma, item) => soma + item.quantidade, 0);

  deps.logger.info("manual_exit_applied", {
    request_id: input.requestId,
    tipo: input.tipo,
    itens: input.itens.length,
    unidades,
    by: caller.userId,
  });

  return { status: "applied", requestId: input.requestId, itens: input.itens.length, unidades };
}
