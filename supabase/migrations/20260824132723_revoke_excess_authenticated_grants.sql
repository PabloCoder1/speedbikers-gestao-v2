-- Auditoria de GRANTs de tabelas antigas (D-062, item P0 do Checkpoint de
-- consolidação pré-Fase 7, `docs/ROADMAP.md`) — achado nunca fechado até
-- agora, medido contra o Dev real (`has_table_privilege`), não presumido.
--
-- Toda tabela nova neste projeto Supabase nasce com INSERT/UPDATE/DELETE
-- concedido a `authenticated` por padrão, mesmo sem GRANT explícito
-- (confirmado pela primeira vez em `saved_filters`, D-062, 2026-08-23).
-- Migrations criadas a partir de D-062 já revogam de `anon, authenticated`
-- na criação. As 23 tabelas abaixo são ANTERIORES a esse achado (criadas
-- entre 2026-08-20 e 2026-08-22) e só revogavam de `anon` — o GRANT
-- excessivo para `authenticated` ficou parado desde então.
--
-- Os dados nunca estiveram expostos: nenhuma das 23 tem policy de escrita
-- para `authenticated` (confirmado consultando `pg_policies` antes de
-- escrever esta migration), então a RLS nega por padrão sem policy
-- correspondente ao comando. Este é um aperto de superfície, não uma
-- correção de vazamento — mas remove um risco latente (uma policy de
-- escrita adicionada por engano no futuro, sem revisar o GRANT, viraria
-- brecha real).
--
-- Excluídas de propósito (têm policy de escrita legítima para
-- `authenticated`, confirmado em `pg_policies`): `ml_accounts`,
-- `organization_members`, `profiles`, `sku_listing_links`,
-- `user_account_permissions`.
--
-- SELECT nunca é tocado — só INSERT/UPDATE/DELETE. `anon` já estava
-- revogado corretamente em todas as 23 desde a criação.

revoke insert, update, delete on
  public.daily_listing_visits,
  public.listings,
  public.suppliers,
  public.purchase_orders,
  public.purchase_order_items,
  public.purchase_order_events,
  public.fulfillment_stock_snapshots,
  public.documents,
  public.document_items,
  public.stock_movements,
  public.inventory_balances,
  public.domain_events,
  public.orders,
  public.order_items,
  public.sync_runs,
  public.sync_errors,
  public.link_candidates,
  public.erp_import_batches,
  public.erp_import_rows,
  public.erp_stock_snapshots,
  public.skus,
  public.sku_components,
  public.organizations
from authenticated;
