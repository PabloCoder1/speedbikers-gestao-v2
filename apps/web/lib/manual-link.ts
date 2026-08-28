/**
 * Vinculação manual livre `Conta + MLB + variation_id? → SKU`
 * (`docs/PRODUCT_REQUIREMENTS.md`, "Vinculação manual livre de anúncio").
 *
 * Requisito aberto desde o Checkpoint pré-Fase 7: a Central de Vinculações
 * dependia de existir um `link_candidate`, e o gerador de candidatos tem uma
 * fonte só — a planilha do UpSeller. Anúncio que o Mercado Livre conhece e a
 * planilha não, nunca teve caminho para ser vinculado pela interface.
 *
 * Este módulo é só a fronteira de ENTRADA: normaliza e recusa antes de tocar
 * o banco, para que a mensagem de erro fale a língua do operador em vez de
 * devolver a violação de CHECK crua. As regras espelham exatamente as
 * constraints de `sku_listing_links` (migration `20260820190000`) — se
 * divergirem, o banco vence e o erro fica feio, nunca errado.
 */

export interface ManualLinkFields {
  readonly mlAccountId: string;
  readonly itemId: string;
  /** Texto cru do formulário. Vazio significa "anúncio sem variação". */
  readonly variationId: string;
  readonly skuId: string;
}

export interface ManualLinkValues {
  readonly mlAccountId: string;
  readonly itemId: string;
  /** `null` = anúncio inteiro. NUNCA repete o `item_id` (comentário da coluna). */
  readonly variationId: string | null;
  readonly skuId: string;
}

export type ManualLinkParse =
  | { readonly ok: true; readonly value: ManualLinkValues }
  | { readonly ok: false; readonly message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID = /^MLB[0-9]+$/;
const VARIATION_ID = /^[0-9]+$/;

export function parseManualLink(fields: ManualLinkFields): ManualLinkParse {
  if (!UUID.test(fields.mlAccountId)) {
    return { ok: false, message: "Escolha a conta Mercado Livre." };
  }

  if (!UUID.test(fields.skuId)) {
    return { ok: false, message: "Escolha o SKU de destino." };
  }

  // `MLB123` e `mlb123` são o mesmo anúncio; a coluna guarda maiúsculo.
  // Espaço colado de um copiar/colar não é erro do operador.
  const itemId = fields.itemId.trim().toUpperCase();

  if (itemId === "") {
    return { ok: false, message: "Informe o MLB do anúncio." };
  }

  if (!ITEM_ID.test(itemId)) {
    return { ok: false, message: `"${fields.itemId.trim()}" não é um MLB válido — o formato é MLB seguido de números.` };
  }

  const variationRaw = fields.variationId.trim();

  if (variationRaw !== "" && !VARIATION_ID.test(variationRaw)) {
    // O caso concreto: colar o MLB inteiro no campo de variação.
    return {
      ok: false,
      message: `"${variationRaw}" não é uma variação válida — a variação é só números. Deixe em branco se o anúncio não tem variação.`,
    };
  }

  return {
    ok: true,
    value: {
      mlAccountId: fields.mlAccountId,
      itemId,
      variationId: variationRaw === "" ? null : variationRaw,
      skuId: fields.skuId,
    },
  };
}
