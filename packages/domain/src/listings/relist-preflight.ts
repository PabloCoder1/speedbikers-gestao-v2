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
 * - `SNAPSHOT_ILEGIVEL` / `SNAPSHOT_INCOMPLETO` — **fail-safe**: o snapshot
 *   é jsonb sem contrato de banco; se a forma não permite VERIFICAR uma
 *   pré-condição, o preflight reprova em vez de presumir que está tudo bem.
 *   Ausência só é aceitável onde ausência é o caso normal (`inventory_id`
 *   ausente = item fora do Full; `parent_item_id` ausente = não é filho).
 *
 * Avisos (nunca bloqueio):
 *
 * - `HERANCA_NAO_OCORRE_EM_FREE` — visitas/vendas não são transferidas em
 *   `listing_type_id: "free"` (secao 2.16, tabela). Republicar continua
 *   permitido; quem decide sabendo é o humano.
 * - `FULL_CADASTRO_SEM_ESTOQUE` — cadastro no Full com zero unidades (D-360):
 *   nada fica preso no CD, mas a doc não diz se o filho herda o cadastro.
 */

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];

  return typeof value === "string" && value !== "" ? value : null;
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
 * as leituras do Full de cada `inventory_id` dele (D-360).
 */
export function evaluateRelistPreflight(
  rawParentSnapshot: unknown,
  fullStock: RelistFullStockReadings = new Map(),
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
