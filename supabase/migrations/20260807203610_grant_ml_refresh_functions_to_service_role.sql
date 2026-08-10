-- ============================================================
-- Speed Bikers Gestão V2
-- Mercado Livre refresh lock backend permissions
-- ============================================================

grant execute
on function public.acquire_ml_refresh_lock(
  uuid,
  uuid,
  integer
)
to service_role;

grant execute
on function public.release_ml_refresh_lock(
  uuid,
  uuid
)
to service_role;