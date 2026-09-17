/**
 * Preflight da republicação (Fase 9, D-160) — a avaliação determinística que
 * roda ANTES de fechar o pai. Fechar é irreversível (`docs/MERCADO_LIVRE.md`
 * secao 2.16: "item encerrado não pode ser reativado"), então o contrato é
 * um só: pré-condição crítica reprovada ⇒ a operação vai para
 * PREFLIGHT_FAILED e NADA é feito no Mercado Livre.
 *
 * Cada bloqueio nasce de um fato da pesquisa oficial, nunca de suposição:
 *
 * - `JA_REPUBLICADO` — a tag `relist` marca "não pode mais" (uma
 *   republicação por pai é regra do próprio ML, secao 2.16).
 * - `FULL_BLOQUEADO` — a doc de relist é SILENCIOSA sobre Full, e o risco é
 *   prender estoque físico no CD. Desde D-360 o bloqueio é pelo que pode
 *   ficar preso: unidades no Full (disponíveis + indisponíveis, lidas ao
 *   vivo em `GET /inventories/{id}/stock/fulfillment`, secao 2.7) ou envio
 *   ativo pelo Full (`shipping.logistic_type = fulfillment`). O
 *   `inventory_id` sozinho não basta: ele continua no item depois que o
 *   Full zera.
 * - `FULL_NAO_VERIFICADO` — **fail-safe** de D-360: o item tem
 *   `inventory_id` (na raiz ou numa variação) e o estoque de algum deles não
 *   foi lido. Sem conferir, não se presume zero.
 * - `CATALOGO_BLOQUEADO` — silêncio documental idêntico; `catalog_listing`
 *   é o campo confirmado (secao 2.5/2.16).
 * - `ENCADEAMENTO_NAO_DOCUMENTADO` — o pai que JÁ É FILHO de um relist
 *   (`parent_item_id` presente) cai no caso "incerto" da doc; bloquear é a
 *   única postura defensável.
 * - `VARIACOES_SEM_ESTOQUE` / `SEM_ESTOQUE` — D-364: sem estoque não há
 *   corpo de relist (`buildRelistBody` devolve `null`), e fechar o pai
 *   sem ter o que republicar deixa o produto fora do ar. Com variações, a
 *   conta é por variação; sem variações, pelo `available_quantity` da raiz.
 * - `VARIACOES_USER_PRODUCT` — D-369: o Mercado Livre RECUSA relist de item
 *   com variações de vendedor no modelo de user products. CONFIRMADO pela
 *   resposta real de 17/09/2026 13:36 UTC ao MLB1476804187 (operação
 *   a7638dc5), causa `item.variations.relist.invalid`. A doc oficial de User
 *   Products identifica esse vendedor pela tag `user_product_seller` em
 *   `/users` e diz que, depois da ativação, o array `variations` não pode mais
 *   ser enviado. A regra é pela CONTA: item com variações bloqueia quando a
 *   conta tem a tag (lida ao vivo pelo worker) OU quando alguma variação traz
 *   `user_product_id` (`hasUserProductVariations`). Item SEM variação com
 *   `user_product_id` na raiz continua permitido: republicou, e o filho
 *   manteve o mesmo user product.
 * - `USER_PRODUCT_NAO_VERIFICADO` — **fail-safe** de D-369: o item tem
 *   variações, nenhuma traz `user_product_id`, e a tag da conta não foi lida.
 *   Sem confirmar o modelo da conta, não se presume que o relist passa.
 * - `SNAPSHOT_ILEGIVEL` / `SNAPSHOT_INCOMPLETO` — **fail-safe**: o snapshot
 *   é jsonb sem contrato de banco; se a forma não permite VERIFICAR uma
 *   pré-condição, o preflight reprova em vez de presumir que está tudo bem.
 *   Ausência só é aceitável onde ausência é o caso normal (`inventory_id`
 *   ausente = item fora do Full; `parent_item_id` ausente = não é filho).
 *   Desde D-364, `variations` e o estoque/preço/id de cada variação também
 *   precisam ser legíveis: são o corpo do POST.
 *
 * Avisos (nunca bloqueio):
 *
 * - `HERANCA_NAO_OCORRE_EM_FREE` — visitas/vendas não são transferidas em
 *   `listing_type_id: "free"` (secao 2.16, tabela). Republicar continua
 *   permitido; quem decide sabendo é o humano.
 * - `FULL_CADASTRO_SEM_ESTOQUE` — cadastro no Full com zero unidades (D-360):
 *   nada fica preso no CD, mas a doc não diz se o filho herda o cadastro.
 * - `VARIACOES_SEM_ESTOQUE_FORA` — D-364: parte das variações está zerada.
 *   Elas ficam fora do corpo, e o anúncio novo nasce sem elas. O dono lê a
 *   lista (`summarizeRelistVariations`) na confirmação da tela, antes de
 *   fechar; o worker a registra no log.
 */

import { hasRelistStock } from "./relist-body.js";

export interface RelistPreflightIssue {
  readonly code: string;
  readonly descricao: string;
}

export interface RelistPreflightResult {
  /** `true` só com ZERO bloqueios — avisos não seguram a operação. */
  readonly approved: boolean;
  readonly blocks: readonly RelistPreflightIssue[];
  readonly warnings: readonly RelistPreflightIssue[];
}

/**
 * Estoque do Full de UM `inventory_id`, lido ao vivo pelo worker (D-360).
 * Os dois números contam: indisponível é unidade avariada, perdida ou em
 * transferência, e continua fisicamente no CD (secao 2.7).
 */
export interface RelistFullStockReading {
  readonly availableQuantity: number;
  readonly notAvailableQuantity: number;
}

/** Leituras por `inventory_id`; `null` (ou ausente) = não foi possível ler. */
export type RelistFullStockReadings = ReadonlyMap<string, RelistFullStockReading | null>;

/**
 * O modelo da CONTA, lido ao vivo pelo worker (D-369): `true` quando
 * `GET /users/me` traz a tag `user_product_seller`, `false` quando a traz sem
 * ela, `null` quando a leitura falhou. Só é lido para item COM variações.
 */
export type RelistSellerUserProducts = boolean | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];

  return typeof value === "string" && value !== "" ? value : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Uma variação que dá para levar ao corpo do relist: id, preço e estoque legíveis. */
interface LegibleVariation {
  readonly id: string;
  readonly available_quantity: number;
}

function readLegibleVariation(variation: unknown): LegibleVariation | null {
  if (!isRecord(variation)) {
    return null;
  }

  const { id, price, available_quantity: quantity } = variation;
  const idText = typeof id === "number" ? String(id) : typeof id === "string" ? id : "";
  const legibleId = /^\d+$/u.test(idText) && Number.isSafeInteger(Number(idText));
  const legiblePrice = typeof price === "number" && Number.isFinite(price);

  return legibleId && legiblePrice && isNonNegativeInteger(quantity) ? { id: idText, available_quantity: quantity } : null;
}

/** Uma variação que o corpo do relist deixa de fora — como a tela a mostra ao dono. */
export interface RelistLeftOutVariation {
  readonly id: string;
  /** `attribute_combinations` como "Color: Preto"; `null` sem combinação legível. */
  readonly label: string | null;
  /** `seller_custom_field`, ou o atributo `SELLER_SKU`; `null` sem nenhum. */
  readonly sku: string | null;
}

export interface RelistVariationsSummary {
  /** Quantas variações o item tem; 0 para item sem variação ou forma ilegível. */
  readonly total: number;
  /** As que ficam FORA do anúncio novo: legíveis e sem estoque, havendo outra com estoque. */
  readonly leftOut: readonly RelistLeftOutVariation[];
}

function describeVariationLabel(variation: Record<string, unknown>): string | null {
  const combinations: unknown[] = Array.isArray(variation.attribute_combinations) ? variation.attribute_combinations : [];
  const parts = combinations
    .map((combination) => {
      if (!isRecord(combination)) {
        return null;
      }

      const name = readOptionalString(combination, "name");
      const value = readOptionalString(combination, "value_name");

      return value === null ? null : name === null ? value : `${name}: ${value}`;
    })
    .filter((part) => part !== null);

  return parts.length === 0 ? null : parts.join(", ");
}

function describeVariationSku(variation: Record<string, unknown>): string | null {
  const sellerCustomField = readOptionalString(variation, "seller_custom_field");

  if (sellerCustomField !== null) {
    return sellerCustomField;
  }

  const attributes: unknown[] = Array.isArray(variation.attributes) ? variation.attributes : [];
  const sellerSku = attributes.find((attribute) => isRecord(attribute) && attribute.id === "SELLER_SKU");

  return isRecord(sellerSku) ? readOptionalString(sellerSku, "value_name") : null;
}

/**
 * As variações do item e as que a republicação deixa de fora (D-364) — o
 * MESMO predicado de `buildRelistBody` e do aviso `VARIACOES_SEM_ESTOQUE_FORA`.
 * Recebe o item cru (o `parent_snapshot` ou o pai ao vivo). Sem variação
 * legível, ou sem nenhuma com estoque (o preflight bloqueia), nada fica "de
 * fora": a lista vem vazia.
 */
export function summarizeRelistVariations(rawItem: unknown): RelistVariationsSummary {
  if (!isRecord(rawItem) || !Array.isArray(rawItem.variations)) {
    return { total: 0, leftOut: [] };
  }

  const variations: unknown[] = rawItem.variations;
  const legible = variations.flatMap((variation) => {
    const read = readLegibleVariation(variation);

    return read === null || !isRecord(variation) ? [] : [{ read, raw: variation }];
  });

  if (legible.length !== variations.length) {
    return { total: variations.length, leftOut: [] };
  }

  const withoutStock = legible.filter(({ read }) => !hasRelistStock(read.available_quantity));

  if (withoutStock.length === legible.length) {
    return { total: variations.length, leftOut: [] };
  }

  return {
    total: variations.length,
    leftOut: withoutStock.map(({ read, raw }) => ({
      id: read.id,
      label: describeVariationLabel(raw),
      sku: describeVariationSku(raw),
    })),
  };
}

/** O código do bloqueio de D-369 — a tela e o log o reconhecem por ele. */
export const RELIST_USER_PRODUCT_VARIATIONS_BLOCK = "VARIACOES_USER_PRODUCT";

/** A descrição do bloqueio de D-369, como o dono a lê no motivo da falha. */
export const RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO =
  "O Mercado Livre não permite republicar anúncio com variações de conta no modelo de user products — fechar o anúncio o deixaria fora do ar sem filho.";

/** O código do fail-safe de D-369: variações, e o modelo da conta não foi lido. */
export const RELIST_SELLER_MODEL_UNVERIFIED_BLOCK = "USER_PRODUCT_NAO_VERIFICADO";

/**
 * A descrição do fail-safe de D-369. Não contém a descrição do bloqueio
 * definitivo: a tela distingue os dois pelo texto gravado.
 */
export const RELIST_SELLER_MODEL_UNVERIFIED_DESCRICAO =
  "O anúncio tem variações e não foi possível confirmar agora se a conta está no modelo de user products, em que o Mercado Livre não aceita republicar variações — sem confirmar, a republicação não fecha o anúncio.";

/** `true` sse o item traz `variations` com pelo menos uma entrada — só então o modelo da conta importa (D-369). */
export function hasRelistVariations(rawItem: unknown): boolean {
  return isRecord(rawItem) && Array.isArray(rawItem.variations) && rawItem.variations.length > 0;
}

/**
 * `true` sse o item tem variações e pelo menos uma traz `user_product_id`
 * preenchido (D-369) — sinal do modelo de user products que dispensa ler a
 * conta. Recebe o item cru (o `parent_snapshot` ou o pai ao vivo; os dois
 * trazem o campo por variação, sem `include_attributes`). Valor que não é
 * texto vazio nem nulo conta como preenchido: na dúvida, o anúncio não é
 * fechado.
 */
export function hasUserProductVariations(rawItem: unknown): boolean {
  if (!isRecord(rawItem) || !Array.isArray(rawItem.variations)) {
    return false;
  }

  const variations: unknown[] = rawItem.variations;

  return variations.some((variation) => {
    if (!isRecord(variation)) {
      return false;
    }

    const userProductId = variation.user_product_id;

    return typeof userProductId === "string" ? userProductId.trim() !== "" : userProductId !== null && userProductId !== undefined;
  });
}

/**
 * A regra de D-369, fail-closed pela CONTA — a mesma no pedido, antes do PUT
 * (em REQUESTED e na retomada de CLOSING) e na retomada humana:
 *
 * - item SEM variações: nada a bloquear (e o worker nem lê a conta);
 * - com variações, a conta com a tag `user_product_seller` OU alguma variação
 *   com `user_product_id`: `VARIACOES_USER_PRODUCT`;
 * - com variações, nenhuma com `user_product_id`, e a conta sem leitura
 *   (`null`): `USER_PRODUCT_NAO_VERIFICADO`;
 * - com variações e a conta confirmada sem a tag (`false`): nada a bloquear.
 */
export function relistUserProductVariationsBlock(
  rawItem: unknown,
  sellerUserProducts: RelistSellerUserProducts,
): RelistPreflightIssue | null {
  if (!hasRelistVariations(rawItem)) {
    return null;
  }

  if (sellerUserProducts === true || hasUserProductVariations(rawItem)) {
    return { code: RELIST_USER_PRODUCT_VARIATIONS_BLOCK, descricao: RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO };
  }

  if (sellerUserProducts === null) {
    return { code: RELIST_SELLER_MODEL_UNVERIFIED_BLOCK, descricao: RELIST_SELLER_MODEL_UNVERIFIED_DESCRICAO };
  }

  return null;
}

function isValidReading(reading: RelistFullStockReading | null | undefined): reading is RelistFullStockReading {
  return (
    reading !== null &&
    reading !== undefined &&
    Number.isFinite(reading.availableQuantity) &&
    reading.availableQuantity >= 0 &&
    Number.isFinite(reading.notAvailableQuantity) &&
    reading.notAvailableQuantity >= 0
  );
}

/**
 * Os `inventory_id` do item — o da raiz e o de cada variação (secao 2.7),
 * sem repetir. É a lista que o worker precisa ler antes do preflight.
 */
export function collectRelistInventoryIds(rawItem: unknown): string[] {
  if (!isRecord(rawItem)) {
    return [];
  }

  const ids = new Set<string>();
  const rootInventoryId = readOptionalString(rawItem, "inventory_id");

  if (rootInventoryId !== null) {
    ids.add(rootInventoryId);
  }

  const variations: unknown[] = Array.isArray(rawItem.variations) ? rawItem.variations : [];

  for (const variation of variations) {
    const variationInventoryId = isRecord(variation) ? readOptionalString(variation, "inventory_id") : null;

    if (variationInventoryId !== null) {
      ids.add(variationInventoryId);
    }
  }

  return [...ids];
}

/**
 * Avalia o snapshot CRU do pai (o `parent_snapshot` capturado na criação da
 * operação, D-159) — o payload de `GET /items/{id}` sem projeção — junto com
 * as leituras do Full de cada `inventory_id` dele (D-360) e o modelo da conta
 * (D-369). Sem a leitura da conta, item com variações reprova: o padrão é
 * `null`, não lido.
 */
export function evaluateRelistPreflight(
  rawParentSnapshot: unknown,
  fullStock: RelistFullStockReadings = new Map(),
  sellerUserProducts: RelistSellerUserProducts = null,
): RelistPreflightResult {
  const blocks: RelistPreflightIssue[] = [];
  const warnings: RelistPreflightIssue[] = [];

  if (!isRecord(rawParentSnapshot)) {
    return {
      approved: false,
      blocks: [
        {
          code: "SNAPSHOT_ILEGIVEL",
          descricao: "O snapshot do anúncio pai não tem a forma de um item — nada pode ser verificado.",
        },
      ],
      warnings: [],
    };
  }

  const item = rawParentSnapshot;

  // tags: todo item carrega o array; sem ele não dá para verificar a regra
  // "uma republicação por pai" — fail-safe.
  const tags = item.tags;

  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    blocks.push({
      code: "SNAPSHOT_INCOMPLETO",
      descricao: "O snapshot não traz `tags` legíveis — impossível verificar se o pai já foi republicado.",
    });
  } else if (tags.includes("relist")) {
    blocks.push({
      code: "JA_REPUBLICADO",
      descricao: "O anúncio carrega a tag `relist`: o Mercado Livre permite UMA republicação por pai, e ela já aconteceu.",
    });
  }

  // Full (D-360). O risco que o bloqueio de D-160 existe para evitar é
  // prender unidade física no CD, e `inventory_id` sozinho não diz isso: ele
  // fica no item depois que o Full zera. Medido em 2026-09-16 no
  // MLB5805901782 — TBWT07652 com zero em oito capturas seguidas, envio por
  // coleta — que a trava antiga recusou. Ausência de `inventory_id` continua
  // sendo o caso normal (item fora do Full).
  const inventoryIds = collectRelistInventoryIds(item);
  const shipping = isRecord(item.shipping) ? item.shipping : null;
  const shipsFromFull = shipping !== null && readOptionalString(shipping, "logistic_type") === "fulfillment";

  if (shipsFromFull) {
    blocks.push({
      code: "FULL_BLOQUEADO",
      descricao:
        "O anúncio envia pelo Full (logistic_type fulfillment) e a documentação de relist é silenciosa sobre o que acontece com ele — bloqueado até validação empírica.",
    });
  } else if (inventoryIds.length > 0) {
    const readings = inventoryIds.map((inventoryId) => fullStock.get(inventoryId)).filter(isValidReading);

    if (readings.length !== inventoryIds.length) {
      blocks.push({
        code: "FULL_NAO_VERIFICADO",
        descricao: `O anúncio tem cadastro no Full (${inventoryIds.join(", ")}) e o estoque de lá não pôde ser lido agora — sem conferir, a republicação não fecha o anúncio.`,
      });
    } else {
      const units = readings.reduce((sum, reading) => sum + reading.availableQuantity + reading.notAvailableQuantity, 0);

      if (units > 0) {
        blocks.push({
          code: "FULL_BLOQUEADO",
          descricao: `O anúncio (ou uma variação) tem ${String(units)} unidade(s) no Full, entre disponíveis e indisponíveis, e a documentação de relist é silenciosa sobre o que acontece com elas — bloqueado até validação empírica.`,
        });
      } else {
        warnings.push({
          code: "FULL_CADASTRO_SEM_ESTOQUE",
          descricao: `Cadastro no Full (${inventoryIds.join(", ")}) com zero unidades: nada fica preso no centro de distribuição, mas a documentação não diz se o anúncio novo herda o cadastro — para voltar a enviar ao Full, pode ser preciso cadastrá-lo de novo.`,
        });
      }
    }
  }

  // Catálogo: `catalog_listing` booleano. Ausente/ilegível = não dá para
  // verificar — fail-safe.
  if (typeof item.catalog_listing !== "boolean") {
    blocks.push({
      code: "SNAPSHOT_INCOMPLETO",
      descricao: "O snapshot não traz `catalog_listing` — impossível verificar se o anúncio participa do catálogo.",
    });
  } else if (item.catalog_listing) {
    blocks.push({
      code: "CATALOGO_BLOQUEADO",
      descricao:
        "O anúncio participa do catálogo e a documentação de relist é silenciosa sobre catálogo — bloqueado até validação empírica.",
    });
  }

  // Encadeamento: o pai que já é FILHO de um relist é o caso "incerto" da
  // doc (a página de visitas tensiona com "uma por pai"). Ausência = normal.
  if (readOptionalString(item, "parent_item_id") !== null) {
    blocks.push({
      code: "ENCADEAMENTO_NAO_DOCUMENTADO",
      descricao:
        "Este anúncio já é filho de uma republicação — encadear relist não é descrito pela documentação oficial.",
    });
  }

  // Estoque que a republicação leva (D-364). O corpo com variações manda
  // só as que têm estoque; sem nenhuma, não há POST possível — e fechar o pai
  // antes de descobrir isso foi o que tirou o MLB1476804187 do ar. Forma
  // ilegível é fail-safe, como o resto: é o corpo do POST.
  const variations = item.variations;

  if (!Array.isArray(variations)) {
    blocks.push({
      code: "SNAPSHOT_INCOMPLETO",
      descricao: "O snapshot não traz `variations` legíveis — impossível montar o corpo da republicação.",
    });
  } else if (variations.length === 0) {
    if (!isNonNegativeInteger(item.available_quantity)) {
      blocks.push({
        code: "SNAPSHOT_INCOMPLETO",
        descricao: "O snapshot não traz `available_quantity` legível — impossível conferir o estoque que a republicação levaria.",
      });
    } else if (!hasRelistStock(item.available_quantity)) {
      blocks.push({
        code: "SEM_ESTOQUE",
        descricao:
          "O anúncio está sem estoque: não há quantidade para republicar, e fechar o anúncio agora o deixaria fora do ar sem anúncio novo.",
      });
    }
  } else {
    const legible = variations.map(readLegibleVariation).filter((variation) => variation !== null);

    if (legible.length !== variations.length) {
      blocks.push({
        code: "SNAPSHOT_INCOMPLETO",
        descricao:
          "O snapshot traz variação sem id, preço ou estoque legível — impossível montar o corpo da republicação.",
      });
    } else {
      const withoutStock = legible.filter((variation) => !hasRelistStock(variation.available_quantity));

      if (withoutStock.length === legible.length) {
        blocks.push({
          code: "VARIACOES_SEM_ESTOQUE",
          descricao: `Nenhuma das ${String(legible.length)} variação(ões) tem estoque: não há o que republicar, e fechar o anúncio agora o deixaria fora do ar sem anúncio novo.`,
        });
      } else if (withoutStock.length > 0) {
        // A lista sai da mesma função que a tela usa na confirmação: o que o
        // log do worker diz e o que o dono lê antes de fechar não divergem.
        const leftOut = summarizeRelistVariations(item).leftOut;

        warnings.push({
          code: "VARIACOES_SEM_ESTOQUE_FORA",
          descricao: `${String(leftOut.length)} de ${String(legible.length)} variação(ões) sem estoque (${leftOut.map((variation) => variation.id).join(", ")}) ficam fora da republicação: o anúncio novo nasce só com as variações que têm estoque.`,
        });
      }
    }
  }

  // User products com variações (D-369). O ML recusou o relist do
  // MLB1476804187 com `item.variations.relist.invalid` — e fechar o pai antes
  // de descobrir isso foi o que o deixou fora do ar. A regra é pela conta, e
  // falha fechada. Independe da legibilidade das outras regras de variação:
  // o bloqueio aparece junto.
  const userProductBlock = relistUserProductVariationsBlock(item, sellerUserProducts);

  if (userProductBlock !== null) {
    blocks.push(userProductBlock);
  }

  // Herança de visitas/vendas: não ocorre em `free`. Aviso, nunca bloqueio.
  const listingTypeId = readOptionalString(item, "listing_type_id");

  if (listingTypeId === null) {
    warnings.push({
      code: "HERANCA_NAO_VERIFICAVEL",
      descricao: "O snapshot não traz `listing_type_id` — não foi possível verificar a herança de visitas/vendas.",
    });
  } else if (listingTypeId === "free") {
    warnings.push({
      code: "HERANCA_NAO_OCORRE_EM_FREE",
      descricao: "Anúncio gratuito: visitas e vendas NÃO são transferidas ao filho (regra oficial).",
    });
  }

  return { approved: blocks.length === 0, blocks, warnings };
}
