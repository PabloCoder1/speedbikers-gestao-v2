/**
 * Strings de projeção do PostgREST que precisam de PROVA, não de revisão.
 *
 * Um `select=` do PostgREST é uma linguagem própria, avaliada só no servidor.
 * Os fakes das suítes de unidade ignoram a string inteira (`select: () =>
 * self`) — de propósito, porque modelá-la seria reimplementar o PostgREST —,
 * e por isso uma projeção errada passa VERDE em toda a suíte e só quebra em
 * produção.
 *
 * Constantes daqui têm teste correspondente em
 * `projections.integration.test.ts`, que roda contra o PostgREST de verdade
 * na pista de integração do CI. A constante e o teste são a mesma string:
 * o teste importa daqui, nunca copia.
 */

/**
 * Vínculo do anúncio + `kind` do SKU + componentes do kit, numa ida só
 * (D-188). Substitui três consultas sequenciais no caminho do webhook, que
 * processa um pedido por vez e não tem o que agrupar.
 *
 * **`!sku_components_kit_sku_id_fkey` não é enfeite.** `sku_components` tem
 * DUAS chaves estrangeiras para `skus` — `kit_sku_id` e `component_sku_id` —
 * e sem nomear qual usar o PostgREST recusa a consulta inteira com
 * `PGRST201: Could not embed because more than one relationship was found`.
 * A forma sem o nome foi testada e falha; é o motivo de este arquivo existir.
 *
 * Forma da resposta, verificada contra o PostgREST real:
 *
 * ```json
 * { "id": "...", "sku_id": "...", "item_id": "MLB...", "variation_id": null,
 *   "skus": { "kind": "KIT", "sku_components": [ { "component_sku_id": "...", "quantity": 3 } ] } }
 * ```
 *
 * `skus` é OBJETO (a relação é muitos-para-um), `sku_components` é ARRAY, e
 * num SKU `PRODUTO` o array vem vazio — não ausente.
 */
export const SKU_LINK_WITH_KIND_SELECT =
  "id, sku_id, item_id, variation_id, skus(kind, sku_components!sku_components_kit_sku_id_fkey(component_sku_id, quantity))";

/** Forma da linha que `SKU_LINK_WITH_KIND_SELECT` devolve. */
export interface SkuLinkWithKindRow {
  id: string;
  sku_id: string;
  item_id: string | null;
  variation_id: string | null;
  skus: { kind: string; sku_components: { component_sku_id: string; quantity: number }[] } | null;
}
