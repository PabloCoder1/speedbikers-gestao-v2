-- ============================================================
-- Ajuste manual de estoque (Fase 4, docs/ROADMAP.md) — `movement_type =
-- AJUSTE_MANUAL` já existia no schema do ledger desde 2026-08-21
-- (20260821200000_create_stock_ledger.sql), mas nenhum código o gerava:
-- hoje um ajuste só nasce via SQL direto.
--
-- `stock_movements` não tinha coluna para o MOTIVO do ajuste — a tabela foi
-- desenhada para movimentos de origem automática (venda, NF-e,
-- reconciliação), onde `source_type`/`source_id` já apontam para o registro
-- que explica o movimento. Um ajuste manual não tem outro registro por
-- trás — o texto do motivo É a explicação, então precisa de coluna própria.
-- Mesmo padrão de `stock_movements_manual_has_creator` (já existente):
-- `reason` é NULL para todo movimento automático, obrigatório só para
-- AJUSTE_MANUAL.
-- ============================================================

alter table public.stock_movements
  add column reason text check (reason is null or char_length(btrim(reason)) between 1 and 500);

comment on column public.stock_movements.reason is
  'Motivo do ajuste manual — obrigatório para AJUSTE_MANUAL (stock_movements_manual_has_reason), nulo para todo movimento automático.';

alter table public.stock_movements
  add constraint stock_movements_manual_has_reason check (
    movement_type <> 'AJUSTE_MANUAL' or reason is not null
  );

-- ============================================================
-- RPC — único caminho de escrita, mesmo padrão de link_document_item/
-- resolve_link_candidate. ADMIN/GESTOR, mesmo nível de NF-e (mexe no
-- ledger diretamente) — mais restrito que a Central de Vinculações.
-- ============================================================

create or replace function public.create_manual_stock_adjustment(
  p_organization_id uuid,
  p_sku_id uuid,
  p_location_kind text,
  p_qty_delta numeric,
  p_reason text
)
returns public.stock_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.stock_movements;
  target_org uuid;
begin
  if not private.is_member_of(p_organization_id) or not private.has_role(array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para ajustar estoque nesta organizacao';
  end if;

  select organization_id into target_org from public.skus where id = p_sku_id;

  if target_org is distinct from p_organization_id then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ajuste manual exige um motivo';
  end if;

  insert into public.stock_movements (
    organization_id, sku_id, location_kind, qty_delta, movement_type,
    reason, created_by, idempotency_key, occurred_at
  ) values (
    p_organization_id, p_sku_id, p_location_kind, p_qty_delta, 'AJUSTE_MANUAL',
    p_reason, (select auth.uid()), 'ajuste-manual:' || gen_random_uuid()::text, now()
  )
  returning * into result;

  return result;
end;
$$;

comment on function public.create_manual_stock_adjustment is
  'Cria um movimento AJUSTE_MANUAL — único caminho de escrita para correção manual de estoque. Autorização (ADMIN/GESTOR) refeita internamente.';

-- `revoke ... from public` não basta neste projeto (achado documentado em
-- link_document_item): `alter default privileges` concede EXECUTE a `anon`
-- em toda função nova do schema public — revogado explicitamente.
revoke all on function public.create_manual_stock_adjustment(uuid, uuid, text, numeric, text)
  from public, anon;
grant execute on function public.create_manual_stock_adjustment(uuid, uuid, text, numeric, text)
  to authenticated;
