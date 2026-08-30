/**
 * Resolução da política de reposição (D-144, Fase 5D) — a peça pura por
 * cima de `replenishment_settings`.
 *
 * Três escopos exclusivos, o MAIS ESPECÍFICO vence: SKU > marca do
 * fornecedor > padrão da organização. Marca é o eixo que D-129 estabeleceu
 * (`skus.supplier_id` não existe de propósito).
 *
 * **`null` é resposta, não erro.** Sem configuração aplicável, quem chama
 * deve RECUSAR a sugestão de compra em vez de inventar um default — mesmo
 * desenho de `stock_is_virtual` na cobertura (D-127): o PRD dá referências
 * (~90 dias para importação, ~15 de lead nacional), e referência é o que o
 * ADMIN digita na tela, nunca o que o código assume.
 *
 * Regra da fórmula única (`docs/ARCHITECTURE.md` §7): esta é a implementação
 * canônica. Quando a sugestão de compra em SQL precisar da resolução, a
 * versão SQL será derivada daqui com teste de equivalência na CI.
 */

export interface ReplenishmentSetting {
  /** Nulo junto com `skuId` = padrão da organização. */
  readonly supplierBrand: string | null;
  readonly skuId: string | null;
  readonly leadTimeDays: number;
  readonly targetCoverageDays: number;
  readonly safetyStockDays: number;
  /**
   * O "buffer máximo" do PRD (D-148): cobertura acima disso é EXCESSO.
   * Nulo = o ADMIN ainda não definiu o que é "demais" — e sem teto o estado
   * EXCESSO nunca é afirmado, nunca chutado.
   */
  readonly maxCoverageDays: number | null;
  readonly policyNote: string | null;
}

export interface ResolvedReplenishmentPolicy extends ReplenishmentSetting {
  /** De onde a política veio — a decomposição visível começa aqui. */
  readonly scope: "SKU" | "MARCA" | "PADRAO";
}

/**
 * `demandWindowDays` é a janela total que a compra precisa cobrir: o prazo
 * até chegar + a cobertura desejada depois de chegar + a segurança. É a
 * resposta direta à armadilha que o PRD nomeia — "comprar 15 dias de estoque
 * com 15 dias de prazo zera antes da entrega": lead time entra na SOMA,
 * nunca substitui a cobertura.
 */
export function demandWindowDays(policy: ResolvedReplenishmentPolicy): number {
  return policy.leadTimeDays + policy.targetCoverageDays + policy.safetyStockDays;
}

export function resolveReplenishmentPolicy(
  settings: readonly ReplenishmentSetting[],
  sku: { readonly id: string; readonly supplierBrand: string | null },
): ResolvedReplenishmentPolicy | null {
  const bySku = settings.find((s) => s.skuId === sku.id);

  if (bySku !== undefined) {
    return { ...bySku, scope: "SKU" };
  }

  // Marca vazia no SKU não casa com configuração de marca nenhuma: 64% dos
  // SKUs ainda não têm `supplier_brand` preenchido (D-129, de propósito), e
  // deixá-los cair numa marca "qualquer" aplicaria a política errada em
  // silêncio. Sem marca, o SKU só pode usar o padrão da organização.
  const byBrand =
    sku.supplierBrand === null
      ? undefined
      : settings.find((s) => s.supplierBrand === sku.supplierBrand && s.skuId === null);

  if (byBrand !== undefined) {
    return { ...byBrand, scope: "MARCA" };
  }

  const orgDefault = settings.find((s) => s.supplierBrand === null && s.skuId === null);

  if (orgDefault !== undefined) {
    return { ...orgDefault, scope: "PADRAO" };
  }

  return null;
}
