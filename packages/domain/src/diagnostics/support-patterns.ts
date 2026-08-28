/**
 * Detecção de padrões de SAC (Fase 7B, D-116) — a ponte entre atendimento e
 * a Central de Ações.
 *
 * A regra do requisito é literal: "um atendimento individual geralmente não
 * precisa virar ação, mas um padrão relevante pode" — o pipeline é
 * `atendimentos → agregação determinística → sinal → Central de Ações →
 * humano decide`. NUNCA por atendimento individual, e NUNCA por palavra
 * solta em mensagem (proibição explícita do requisito).
 *
 * **A regra desta fatia é um SNAPSHOT, não uma série**: N reclamações
 * ABERTAS simultaneamente no mesmo SKU. Deliberado, e não por falta de
 * ambição — "aumento anormal de mediações" exigiria baseline histórico de
 * claims, e a série só existe desde 2026-08-28 (D-109 completou a
 * ingestão). Um limiar sobre estado presente é operacionalmente verdadeiro
 * com qualquer profundidade de histórico; um z-score sobre 3 dias de série
 * seria estatística de mentira.
 */

/** Reclamações abertas simultâneas no MESMO SKU para virar ação. */
export const SUPPORT_PATTERN_MIN_OPEN_CLAIMS = 3;

export interface SkuClaimAggregate {
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
  /** Cases CLAIM com `internal_status <> 'RESOLVIDO'` vinculados ao SKU. */
  readonly openClaims: number;
  /** Quantos dos abertos estão em mediação (`stage='dispute'`, D-104). */
  readonly openMediations: number;
  /** Soma de `orders.total_amount` dos pedidos vinculados a esses cases — dinheiro em risco real, não estimado. */
  readonly linkedOrdersTotalBrl: number | null;
}

export interface SupportPatternFinding {
  readonly skuId: string;
  readonly openClaims: number;
  readonly openMediations: number;
  readonly impactBrl: number | null;
  readonly evidencias: readonly { tipo: string; descricao: string }[];
  readonly recomendacao: string;
  /**
   * SEM data na chave: a condição é persistente, e cada dia que ela durar
   * atualiza a MESMA ação (o upsert de D-064 preserva status/responsável —
   * ação resolvida por humano não reabre sozinha, semântica idêntica à de
   * `sales_anomaly`).
   */
  readonly dedupKey: string;
}

export function detectSupportPatterns(aggregates: readonly SkuClaimAggregate[]): SupportPatternFinding[] {
  const findings: SupportPatternFinding[] = [];

  for (const aggregate of aggregates) {
    if (aggregate.openClaims < SUPPORT_PATTERN_MIN_OPEN_CLAIMS) {
      continue;
    }

    const nome = aggregate.title === null ? aggregate.sku : `${aggregate.sku} (${aggregate.title})`;

    const evidencias = [
      {
        tipo: "reclamacoes_abertas",
        descricao: `${String(aggregate.openClaims)} reclamações abertas simultaneamente no SKU ${nome}.`,
      },
      ...(aggregate.openMediations > 0
        ? [
            {
              tipo: "mediacoes",
              descricao: `${String(aggregate.openMediations)} delas já em mediação com o Mercado Livre.`,
            },
          ]
        : []),
      ...(aggregate.linkedOrdersTotalBrl !== null
        ? [
            {
              tipo: "valor_em_risco",
              descricao: `Pedidos vinculados somam R$ ${aggregate.linkedOrdersTotalBrl.toFixed(2)} em risco de reembolso.`,
            },
          ]
        : []),
    ];

    findings.push({
      skuId: aggregate.skuId,
      openClaims: aggregate.openClaims,
      openMediations: aggregate.openMediations,
      impactBrl: aggregate.linkedOrdersTotalBrl,
      evidencias,
      recomendacao:
        "Revisar as reclamações abertas deste SKU na Caixa de Entrada e investigar causa comum (defeito de lote, anúncio enganoso, problema de envio).",
      dedupKey: `support_pattern:claims:${aggregate.skuId}`,
    });
  }

  return findings;
}
