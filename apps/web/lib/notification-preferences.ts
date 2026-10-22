/**
 * Aplica `notification_preferences` na entrega em tempo real (toast) — a
 * ÚNICA camada onde a preferência ainda é consultada desde a correção de
 * 2026-08-24 (D-076, `supabase/migrations/20260824210000_fix_notification_preferences_scope.sql`).
 * A criação do registro em `notification_recipients` (e portanto a
 * visibilidade na Central de Notificações) nunca é filtrada por preferência
 * — `docs/NOTIFICATIONS.md` secao 1.
 *
 * Mesma lógica de especificidade que a trigger original tinha em SQL
 * (`event_type`/`ml_account_id` batendo os dois > só um > nenhum, curinga
 * geral vence por último), só que avaliada aqui porque agora é o único
 * lugar que ainda decide alguma coisa com base na preferência.
 *
 * D-642 (C-82): a origem pode ser a conta do ML OU a loja da Shopee, nunca as
 * duas (o banco recusa a linha com as duas). A regra da loja só casa evento da
 * MESMA loja; a regra de conta nunca casa evento de loja (ele chega com
 * `ml_account_id` nulo). Na especificidade, a loja conta como a conta conta.
 */

export interface NotificationPreferenceRule {
  eventType: string | null;
  mlAccountId: string | null;
  /** D-642: a loja da Shopee; ausente vale nulo (a regra de antes do C-82). */
  shopeeShopId?: string | null;
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
  event: { eventType: string; mlAccountId: string | null; shopeeShopId?: string | null; severity: string },
): boolean {
  let best: NotificationPreferenceRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    const eventMatches = rule.eventType === null || rule.eventType === event.eventType;
    const regraDaLoja = rule.shopeeShopId ?? null;
    const accountMatches = rule.mlAccountId === null || rule.mlAccountId === event.mlAccountId;
    const lojaMatches = regraDaLoja === null || regraDaLoja === (event.shopeeShopId ?? null);

    if (!eventMatches || !accountMatches || !lojaMatches) continue;

    const score = (rule.eventType !== null ? 1 : 0) + (rule.mlAccountId !== null || regraDaLoja !== null ? 1 : 0);

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
