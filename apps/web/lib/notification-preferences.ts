/**
 * Aplica `notification_preferences` na entrega em tempo real (toast) — a
 * ÚNICA camada onde a preferência ainda é consultada desde a correção de
 * 2026-08-24 (D-076, `supabase/migrations/20260824210000_fix_notification_preferences_scope.sql`).
 * A criação do registro em `notification_recipients` (e portanto a
 * visibilidade na Central de Notificações) nunca é filtrada por preferência
 * — `docs/NOTIFICATIONS.md` secao 1.
 *
 * Uma regra com tipo e origem precede uma regra com apenas um deles. A
 * origem pode ser uma conta do Mercado Livre ou uma loja da Shopee (D-635).
 * A regra geral é usada por último.
 */

export interface NotificationPreferenceRule {
  eventType: string | null;
  mlAccountId: string | null;
  shopeeShopId: string | null;
  minSeverity: string;
  enabled: boolean;
}

const SEVERITY_RANK: Record<string, number> = {
  informativo: 1,
  importante: 2,
  critico: 3,
};

export function shouldNotify(
  rules: readonly NotificationPreferenceRule[],
  event: { eventType: string; mlAccountId: string | null; shopeeShopId: string | null; severity: string },
): boolean {
  let best: NotificationPreferenceRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    const eventMatches = rule.eventType === null || rule.eventType === event.eventType;
    const accountMatches = rule.mlAccountId === null || rule.mlAccountId === event.mlAccountId;
    const shopMatches = rule.shopeeShopId === null || rule.shopeeShopId === event.shopeeShopId;

    if (!eventMatches || !accountMatches || !shopMatches) continue;

    const hasOrigin = rule.mlAccountId !== null || rule.shopeeShopId !== null;
    const score = (rule.eventType !== null ? 1 : 0) + (hasOrigin ? 1 : 0);

    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  // Sem preferência aplicável: notifica por padrão (mesmo default seguro
  // já documentado desde D-073).
  if (best === null) return true;

  if (!best.enabled) return false;

  return (SEVERITY_RANK[best.minSeverity] ?? 1) <= (SEVERITY_RANK[event.severity] ?? 1);
}
