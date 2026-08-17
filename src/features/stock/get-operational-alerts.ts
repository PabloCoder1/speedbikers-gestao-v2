import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

const INTEGER_FORMATTER = new Intl.NumberFormat("pt-BR");
const CURRENCY_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export type OperationalAlertSeverity = "critical" | "warning" | "info";
export type OperationalAlertStatus = "open" | "resolved";
export type OperationalAlertScope = OperationalAlertStatus | "all";

type AlertRow = {
  id: string;
  product_id: string;
  alert_type: string;
  severity: OperationalAlertSeverity;
  status: OperationalAlertStatus;
  evidence: unknown;
  suggested_action_code: string | null;
  last_seen_at: string;
  resolved_at: string | null;
  sku: string;
  product_name: string | null;
};

type AlertPresentation = {
  title: string;
  category: string;
  defaultDescription: string;
};

export type OperationalAlertItem = {
  id: string;
  productId: string;
  sku: string;
  productName: string | null;
  title: string;
  category: string;
  description: string;
  severity: OperationalAlertSeverity;
  status: OperationalAlertStatus;
  actionLabel: string;
  lastSeenAt: string;
  resolvedAt: string | null;
};

export type OperationalAlertsOverview = {
  summary: {
    open: number;
    critical: number;
    warning: number;
    info: number;
    resolved: number;
  };
  alerts: OperationalAlertItem[];
};

const ALERT_PRESENTATION: Record<string, AlertPresentation> = {
  PHYSICAL_OUT_OF_STOCK: {
    title: "Sem estoque físico",
    category: "Estoque físico",
    defaultDescription: "O saldo físico disponível chegou a zero.",
  },
  PHYSICAL_LOW_STOCK: {
    title: "Estoque físico baixo",
    category: "Estoque físico",
    defaultDescription: "O saldo disponível está abaixo da referência de estoque baixo.",
  },
  KIT_COMPONENT_STOCK_UNKNOWN: {
    title: "Kit com saldo incompleto",
    category: "Kits",
    defaultDescription: "Um ou mais componentes impedem o cálculo confiável do kit.",
  },
  PHYSICAL_STOCK_UNKNOWN: {
    title: "Saldo físico indisponível",
    category: "Estoque físico",
    defaultDescription: "O vínculo existe, mas a fonte física ainda não possui um saldo confiável.",
  },
  KIT_DOTTED_COMPONENTS_UNRESOLVED: {
    title: "Kit por ponto não resolvido",
    category: "Kits",
    defaultDescription: "Um ou mais segmentos do SKU não existem no catálogo ou no estoque físico.",
  },
  STOCK_MAPPING_MISSING: {
    title: "Produto sem vínculo de estoque",
    category: "Integração UpSeller",
    defaultDescription: "O produto anunciado ainda não foi associado a um SKU do UpSeller.",
  },
  STOCK_MAPPING_CONFLICT: {
    title: "Conflito no vínculo de estoque",
    category: "Integração UpSeller",
    defaultDescription: "Mais de um SKU pode representar este produto e precisa de revisão.",
  },
  FULL_OUT_OF_STOCK: {
    title: "Sem estoque no Full",
    category: "Mercado Livre Full",
    defaultDescription: "O inventário monitorado no Full chegou a zero.",
  },
  FULL_REPLENISH_FROM_PHYSICAL: {
    title: "Repor Full a partir do estoque físico",
    category: "Mercado Livre Full",
    defaultDescription: "O Full está zerado e há saldo físico disponível para reposição.",
  },
  PURCHASE_REPLENISHMENT_REQUIRED: {
    title: "Compra de reposição necessária",
    category: "Compras",
    defaultDescription: "O estoque físico zerou e existe velocidade de venda confiável.",
  },
  PURCHASE_REPLENISHMENT_DUE: {
    title: "Compra de reposição no prazo",
    category: "Compras",
    defaultDescription: "A cobertura física está dentro do prazo de compra da marca.",
  },
  FULL_UNAVAILABLE_UNITS: {
    title: "Unidades indisponíveis no Full",
    category: "Mercado Livre Full",
    defaultDescription: "Há unidades no Full que ainda não estão disponíveis para venda.",
  },
  ACTIVE_LISTING_NO_ADVERTISED_AVAILABILITY: {
    title: "Anúncio ativo sem disponibilidade",
    category: "Anúncios",
    defaultDescription: "Existe anúncio ativo com disponibilidade publicada igual a zero.",
  },
  ADVERTISED_ABOVE_PHYSICAL_AVAILABLE: {
    title: "Anunciado acima do estoque físico",
    category: "Anúncios",
    defaultDescription: "A disponibilidade publicada está acima do saldo físico conhecido.",
  },
  FINAL_PRICE_DIVERGENCE: {
    title: "Divergência de preço final",
    category: "Preços",
    defaultDescription: "O mesmo produto está com preços finais diferentes entre anúncios.",
  },
  BASE_PRICE_DIVERGENCE: {
    title: "Divergência de preço-base",
    category: "Preços",
    defaultDescription: "O mesmo produto está com preços-base diferentes entre anúncios.",
  },
  PRICE_VALIDATION_PENDING: {
    title: "Preço aguardando validação",
    category: "Preços",
    defaultDescription: "Nem todos os anúncios ativos tiveram o preço validado ainda.",
  },
  PROMOTION_EXPLANATION_UNCERTAIN: {
    title: "Promoção com leitura incerta",
    category: "Preços",
    defaultDescription: "A promoção ativa não pôde ser explicada com segurança.",
  },
};

const ACTION_LABELS: Record<string, string> = {
  review_physical_replenishment: "Revisar reposição física",
  review_stock_source: "Revisar fonte de estoque",
  review_kit_components: "Revisar componentes do kit",
  review_stock_mapping: "Vincular produto ao UpSeller",
  resolve_stock_mapping_conflict: "Resolver conflito de vínculo",
  review_full_replenishment: "Revisar reposição do Full",
  replenish_full_from_physical: "Planejar envio ao Full",
  create_purchase_replenishment: "Planejar compra",
  review_full_unavailable_units: "Verificar unidades indisponíveis",
  review_advertised_availability: "Revisar disponibilidade anunciada",
  review_advertised_vs_physical: "Comparar anúncio e estoque físico",
};

function asEvidence(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function evidenceNumber(evidence: Record<string, unknown>, key: string) {
  const parsed = Number(evidence[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceText(evidence: Record<string, unknown>, key: string) {
  const value = evidence[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evidenceArrayLength(evidence: Record<string, unknown>, key: string) {
  const value = evidence[key];
  return Array.isArray(value) ? value.length : null;
}

function formatQuantity(value: number) {
  return INTEGER_FORMATTER.format(value);
}

function buildDescription(
  alertType: string,
  evidenceValue: unknown,
  fallback: string,
) {
  const evidence = asEvidence(evidenceValue);

  if (alertType === "PHYSICAL_LOW_STOCK") {
    const available = evidenceNumber(evidence, "available");
    const threshold = evidenceNumber(evidence, "lowStockThreshold");
    if (available !== null && threshold !== null) {
      return `${formatQuantity(available)} disponível(is) para uma referência mínima de ${formatQuantity(threshold)}.`;
    }
  }

  if (alertType === "KIT_COMPONENT_STOCK_UNKNOWN") {
    const missing = evidenceArrayLength(evidence, "missingComponents");
    if (missing !== null && missing > 0) {
      return `${formatQuantity(missing)} componente(s) ainda estão sem saldo confiável.`;
    }
  }

  if (alertType === "STOCK_MAPPING_MISSING") {
    const listings = evidenceNumber(evidence, "listingCount");
    if (listings !== null) {
      return `${formatQuantity(listings)} anúncio(s) aguardam o vínculo com um SKU do UpSeller.`;
    }
  }

  if (alertType === "STOCK_MAPPING_CONFLICT") {
    const candidates = evidenceArrayLength(evidence, "candidates");
    if (candidates !== null) {
      return `${formatQuantity(candidates)} SKU(s) candidato(s) precisam ser conferidos.`;
    }
  }

  if (alertType === "FULL_OUT_OF_STOCK") {
    const account = evidenceText(evidence, "accountName") ?? evidenceText(evidence, "accountCode");
    if (account) {
      return `${account} está sem unidades disponíveis no Full.`;
    }
  }

  if (alertType === "FULL_REPLENISH_FROM_PHYSICAL") {
    const physical = evidenceNumber(evidence, "physicalAvailable");
    const account = evidenceText(evidence, "accountName") ?? evidenceText(evidence, "accountCode");
    if (physical !== null) {
      return `${account ? `${account}: ` : ""}Full zerado com ${formatQuantity(physical)} unidade(s) disponíveis no estoque físico.`;
    }
  }

  if (alertType === "PURCHASE_REPLENISHMENT_REQUIRED" || alertType === "PURCHASE_REPLENISHMENT_DUE") {
    const physical = evidenceNumber(evidence, "physicalAvailable");
    const coverage = evidenceNumber(evidence, "physicalCoverageDays");
    const leadTime = evidenceNumber(evidence, "purchaseLeadTimeDays");
    if (physical !== null && leadTime !== null) {
      const coverageText = coverage === null ? "sem cobertura calculável" : `${coverage.toFixed(1)} dia(s) de cobertura`;
      return `${formatQuantity(physical)} unidade(s) físicas, ${coverageText} e prazo de compra de ${formatQuantity(leadTime)} dia(s).`;
    }
  }

  if (alertType === "FULL_UNAVAILABLE_UNITS") {
    const unavailable = evidenceNumber(evidence, "notAvailable");
    const account = evidenceText(evidence, "accountName") ?? evidenceText(evidence, "accountCode");
    if (unavailable !== null) {
      const prefix = account ? `${account}: ` : "";
      return `${prefix}${formatQuantity(unavailable)} unidade(s) estão indisponíveis no Full.`;
    }
  }

  if (alertType === "ACTIVE_LISTING_NO_ADVERTISED_AVAILABILITY") {
    const affected = evidenceNumber(evidence, "affectedOffers");
    if (affected !== null) {
      return `${formatQuantity(affected)} anúncio(s) ativo(s) estão sem disponibilidade publicada.`;
    }
  }

  if (alertType === "ADVERTISED_ABOVE_PHYSICAL_AVAILABLE") {
    const physical = evidenceNumber(evidence, "physicalAvailable");
    const offers = evidenceArrayLength(evidence, "offers");
    if (physical !== null && offers !== null) {
      return `${formatQuantity(offers)} anúncio(s) estão acima do saldo físico de ${formatQuantity(physical)}.`;
    }
  }

  if (alertType === "FINAL_PRICE_DIVERGENCE" || alertType === "BASE_PRICE_DIVERGENCE") {
    const minimum = evidenceNumber(evidence, "min");
    const maximum = evidenceNumber(evidence, "max");
    if (minimum !== null && maximum !== null) {
      return `Faixa identificada entre ${CURRENCY_FORMATTER.format(minimum)} e ${CURRENCY_FORMATTER.format(maximum)}.`;
    }
  }

  if (alertType === "PRICE_VALIDATION_PENDING") {
    const pending = evidenceNumber(evidence, "pendingListings");
    if (pending !== null) {
      return `${formatQuantity(pending)} anúncio(s) ativo(s) ainda aguardam validação de preço.`;
    }
  }

  if (alertType === "PROMOTION_EXPLANATION_UNCERTAIN") {
    const listings = evidenceArrayLength(evidence, "listings");
    if (listings !== null) {
      return `${formatQuantity(listings)} anúncio(s) têm promoção com leitura incerta.`;
    }
  }

  return fallback;
}

export async function getOperationalAlerts(
  scope: OperationalAlertScope,
): Promise<OperationalAlertsOverview | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const organizationId = access.organizationId;
  const { data, error } = await supabase.rpc("get_operational_alerts_data", {
    target_organization_id: organizationId,
    requested_scope: scope,
  });
  if (error || !data || typeof data !== "object") {
    throw new Error(`OPERATIONAL_ALERTS_READ_MODEL_FAILED:${error?.message ?? "empty_result"}`);
  }

  const readModel = data as unknown as {
    summary?: Partial<OperationalAlertsOverview["summary"]>;
    alerts?: AlertRow[];
  };
  const alertRows = readModel.alerts ?? [];
  const alerts = alertRows.map((alert): OperationalAlertItem => {
    const presentation = ALERT_PRESENTATION[alert.alert_type] ?? {
      title: "Alerta operacional",
      category: "Operação",
      defaultDescription: "Este produto precisa de revisão operacional.",
    };

    return {
      id: alert.id,
      productId: alert.product_id,
      sku: alert.sku ?? "Produto removido",
      productName: alert.product_name ?? null,
      title: presentation.title,
      category: presentation.category,
      description: buildDescription(
        alert.alert_type,
        alert.evidence,
        presentation.defaultDescription,
      ),
      severity: alert.severity,
      status: alert.status,
      actionLabel: alert.suggested_action_code
        ? ACTION_LABELS[alert.suggested_action_code] ?? "Abrir produto"
        : "Abrir produto",
      lastSeenAt: alert.last_seen_at,
      resolvedAt: alert.resolved_at,
    };
  });

  return {
    summary: {
      open: Number(readModel.summary?.open ?? 0),
      critical: Number(readModel.summary?.critical ?? 0),
      warning: Number(readModel.summary?.warning ?? 0),
      info: Number(readModel.summary?.info ?? 0),
      resolved: Number(readModel.summary?.resolved ?? 0),
    },
    alerts,
  };
}
