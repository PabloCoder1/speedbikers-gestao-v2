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
 *   prender estoque físico no CD. Full é identificado por `inventory_id`
 *   no campo raiz do item, ou por variação (secao 2.7, exemplo oficial).
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
 * Aviso (nunca bloqueio):
 *
 * - `HERANCA_NAO_OCORRE_EM_FREE` — visitas/vendas não são transferidas em
 *   `listing_type_id: "free"` (secao 2.16, tabela). Republicar continua
 *   permitido; quem decide sabendo é o humano.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];

  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Avalia o snapshot CRU do pai (o `parent_snapshot` capturado na criação da
 * operação, D-159) — o payload de `GET /items/{id}` sem projeção.
 */
export function evaluateRelistPreflight(rawParentSnapshot: unknown): RelistPreflightResult {
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

  // Full: `inventory_id` na raiz OU em qualquer variação (secao 2.7).
  // Ausência aqui é o caso normal (item fora do Full) — não é lacuna.
  const rootInventoryId = readOptionalString(item, "inventory_id");
  const variations = Array.isArray(item.variations) ? item.variations : [];
  const variationHasInventory = variations.some(
    (variation) => isRecord(variation) && readOptionalString(variation, "inventory_id") !== null,
  );

  if (rootInventoryId !== null || variationHasInventory) {
    blocks.push({
      code: "FULL_BLOQUEADO",
      descricao:
        "O anúncio (ou uma variação) tem estoque no Full e a documentação de relist é silenciosa sobre o que acontece com ele — bloqueado até validação empírica.",
    });
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
