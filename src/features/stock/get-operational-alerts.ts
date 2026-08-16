import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 800;
const MAX_PAGES = 25;
const INTEGER_FORMATTER = new Intl.NumberFormat("pt-BR");
const CURRENCY_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export type OperationalAlertSeverity = "critical" | "warning" | "info";
export type OperationalAlertStatus = "open" | "resolved";
export type OperationalAlertScope = OperationalAlertStatus | "all";

type ProductRow = {
  id: string;
  sku: string;
  name: string | null;
};

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
};

type QueryPage<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type CountResult = {
  count: number | null;
  error: { message: string } | null;
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
  review_kit_components: "Revisar componentes do kit",
  review_stock_mapping: "Vincular produto ao UpSeller",
  resolve_stock_mapping_conflict: "Resolver conflito de vínculo",
  review_full_replenishment: "Revisar reposição do Full",
  review_full_unavailable_units: "Verificar unidades indisponíveis",
  review_advertised_availability: "Revisar disponibilidade anunciada",
  review_advertised_vs_physical: "Comparar anúncio e estoque físico",
};

async function collectPages<T>(
  label: string,
  loadPage: (from: number, to: number) => PromiseLike<QueryPage<T>>,
) {
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`${label}:${error.message}`);

    const pageRows = data ?? [];
    rows.push(...pageRows);

    if (pageRows.length < PAGE_SIZE) return rows;
  }

  throw new Error(`${label}:result_limit_exceeded`);
}

function countOrThrow(label: string, result: CountResult) {
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.count ?? 0;
}

function asEvidence(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function evidenceNumber(evidence: Record<string, unknown>, key: string) {
  const parsed = Number(evidence[key]);
  return Number.isFinite(parsed) ? parsed : null;
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

  if (alertType === "FULL_UNAVAILABLE_UNITS") {
    const unavailable = evidenceNumber(evidence, "notAvailable");
    if (unavailable !== null) {
      return `${formatQuantity(unavailable)} unidade(s) estão indisponíveis no Full.`;
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
  const loadAlerts = (from: number, to: number) => {
    let query = supabase
      .from("operational_alerts")
      .select(
        "id,product_id,alert_type,severity,status,evidence,suggested_action_code,last_seen_at,resolved_at",
      )
      .eq("organization_id", organizationId);

    if (scope !== "all") query = query.eq("status", scope);

    return query
      .order("last_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
      .returns<AlertRow[]>();
  };

  const [
    products,
    alertRows,
    openCount,
    criticalCount,
    warningCount,
    infoCount,
    resolvedCount,
  ] = await Promise.all([
    collectPages<ProductRow>("OPERATIONAL_ALERTS_PRODUCTS_FAILED", (from, to) =>
      supabase
        .from("products")
        .select("id,sku,name")
        .eq("organization_id", organizationId)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ProductRow[]>(),
    ),
    collectPages<AlertRow>("OPERATIONAL_ALERTS_LIST_FAILED", loadAlerts),
    supabase
      .from("operational_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "open"),
    supabase
      .from("operational_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .eq("severity", "critical"),
    supabase
      .from("operational_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .eq("severity", "warning"),
    supabase
      .from("operational_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "open")
      .eq("severity", "info"),
    supabase
      .from("operational_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "resolved"),
  ]);

  const productsById = new Map(products.map((product) => [product.id, product]));
  const alerts = alertRows.map((alert): OperationalAlertItem => {
    const product = productsById.get(alert.product_id);
    const presentation = ALERT_PRESENTATION[alert.alert_type] ?? {
      title: "Alerta operacional",
      category: "Operação",
      defaultDescription: "Este produto precisa de revisão operacional.",
    };

    return {
      id: alert.id,
      productId: alert.product_id,
      sku: product?.sku ?? "Produto removido",
      productName: product?.name ?? null,
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
      open: countOrThrow("OPERATIONAL_ALERTS_OPEN_COUNT_FAILED", openCount),
      critical: countOrThrow("OPERATIONAL_ALERTS_CRITICAL_COUNT_FAILED", criticalCount),
      warning: countOrThrow("OPERATIONAL_ALERTS_WARNING_COUNT_FAILED", warningCount),
      info: countOrThrow("OPERATIONAL_ALERTS_INFO_COUNT_FAILED", infoCount),
      resolved: countOrThrow("OPERATIONAL_ALERTS_RESOLVED_COUNT_FAILED", resolvedCount),
    },
    alerts,
  };
}
