-- Pre-existing bug found by smoke-testing the recovered purchase-order
-- RPCs: create_purchase_order_from_planning and upsert_purchase_order_item
-- are plain invoker-mode functions (no `security definer`) granted to
-- service_role, and both call private.get_purchase_planning_signals(...)
-- directly. service_role had EXECUTE on that function but never USAGE on
-- the `private` schema itself, so any real call from application code
-- (via the admin/service-role client) would fail with
-- "permission denied for schema private" the moment it tried to plan an
-- order. Reproduced with a rolled-back transaction against production
-- before this fix; confirmed fixed after.

grant usage on schema private to service_role;
