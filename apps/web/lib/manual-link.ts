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

/**
 * Descreve o vínculo que já existe, para a recusa dizer o que está no lugar.
 * O requisito é explícito: "nunca sobrescrever silenciosamente um vínculo
 * existente incompatível" — então a mensagem precisa nomear o ocupante.
 */
export function describeExistingLink(existing: {
  readonly sku: string | null;
  readonly source: string;
}): string {
  const nome = existing.sku ?? "um SKU que você não alcança";
  const origem =
    existing.source === "IMPORT_UPSELLER"
      ? "veio da planilha do UpSeller"
      : existing.source === "MANUAL"
        ? "foi feito à mão"
        : `origem ${existing.source}`;

  // NÃO instruir "desfaça o vínculo atual": remover vínculo não existe em
  // lugar nenhum do produto hoje (nenhum código de `apps/web` apaga desta
  // tabela). Prometer um caminho inexistente é pior que declarar o limite.
  return `Este anúncio já está vinculado ao SKU ${nome} (${origem}). Nada foi sobrescrito — trocar um vínculo existente ainda não é possível por esta tela.`;
}

/**
 * As duas formas de vínculo de um mesmo anúncio — "anúncio inteiro"
 * (`variation_id` nulo) e "variação X" — vivem em índices únicos PARCIAIS
 * diferentes, então o banco aceita as duas convivendo. Semanticamente elas se
 * excluem, e a mistura tem consequência concreta: `ml-listings-fetch` e
 * `ml-fulfillment-fetch` enumeram os vínculos SEM variação e atribuem o
 * estoque Full do item ao SKU desse vínculo. Um vínculo de anúncio inteiro
 * criado sobre um anúncio que só vende por variação não resolve venda nenhuma
 * (o pedido sempre traz a variação) e ainda leva o Full para o SKU errado.
 */
export function describeShapeConflict(inserindoAnuncioInteiro: boolean): string {
  return inserindoAnuncioInteiro
    ? "Este anúncio já tem vínculos por VARIAÇÃO. Vincular o anúncio inteiro por cima criaria um vínculo que nunca resolve venda e ainda puxaria o estoque Full para este SKU — informe a variação."
    : "Este anúncio já está vinculado como ANÚNCIO INTEIRO (sem variação). Misturar as duas formas deixa o estoque Full atribuído ao vínculo antigo — resolva o vínculo existente antes de vincular por variação.";
}
