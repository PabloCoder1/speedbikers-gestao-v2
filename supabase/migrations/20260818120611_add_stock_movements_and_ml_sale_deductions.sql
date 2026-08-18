-- ============================================================
-- BAIXA DE ESTOQUE ENTRE IMPORTAÇÕES DO UPSELLER
-- ============================================================
--
-- Aplicada em produção como 20260818120611.
--
-- Problema: o UpSeller já baixa o estoque na venda, mas não tem API. Entre
-- uma importação de planilha e a próxima, o número exibido envelhece.
--
-- Solução: calcular a baixa localmente e fazê-la EXPIRAR sozinha quando
-- uma planilha nova chegar — senão a baixa do UpSeller e a nossa se somam
-- e o estoque despenca errado.
--
-- O mecanismo de expiração é o mesmo já usado por
-- current_stock_receipt_adjustments: só conta o movimento posterior ao
-- retrato de estoque vigente (state.checked_at). Quando a planilha nova
-- entra, checked_at avança e os movimentos antigos param de contar
-- automaticamente, sem job de limpeza.
--
-- REGRA CRÍTICA — Full não desconta do físico.
--
-- Medido em produção (7 dias): 6.641 unidades pagas em Full contra 673
-- próprio/flex. A unidade vendida em Full já havia saído do ESTOQUE LOJA
-- quando foi enviada ao Mercado Livre, não quando vendeu. Descontar a
-- venda Full do físico subtrairia ~10x a mais do que o correto. O saldo
-- Full vem da API do ML (ml_fulfillment_stock_states) e é autoritativo.
--
-- Só existe um depósito no UpSeller (ESTOQUE LOJA, 3.381 SKUs), então
-- toda baixa física é atribuída a ele.
--
-- Kits ficam de fora da baixa automática nesta versão: a venda de um kit
-- consome componentes em proporções distintas e merece tratamento próprio.

-- ------------------------------------------------------------
-- 1. LIVRO-RAZÃO DE MOVIMENTOS MANUAIS
-- ------------------------------------------------------------
--
-- Vendas são derivadas de order_items (assim cancelamento se autocorrige).
-- Saídas manuais são entrada do usuário e precisam ser registradas.

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sku_key text not null,
  source_sku text not null,
  warehouse_key text not null default 'ESTOQUE LOJA',
  movement_kind text not null check (movement_kind in ('manual_exit', 'manual_entry', 'adjustment')),
  quantity numeric not null check (quantity <> 0),
  reason text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_org_sku_idx
  on public.stock_movements (organization_id, sku_key, occurred_at desc);

alter table public.stock_movements enable row level security;

drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using (private.is_organization_member(organization_id));

-- Inserção só via RPC com validação; nada de insert direto do cliente.
revoke insert, update, delete on public.stock_movements from authenticated;

-- ------------------------------------------------------------
-- 2. BAIXA DERIVADA DAS VENDAS DO MERCADO LIVRE
-- ------------------------------------------------------------

create or replace view public.current_ml_sale_deductions
with (security_invoker = true)
as
select
  state.organization_id,
  state.sku_key,
  state.warehouse_key,
  sum(item.quantity)::numeric as quantity,
  max(orders.date_created) as last_sale_at,
  count(*)::bigint as sale_lines
from public.upseller_stock_states as state
join public.product_inventory_links as link
  on link.organization_id = state.organization_id
 and link.source_sku_key = state.sku_key
 and link.source = 'upseller'
 and link.is_active
 and link.source_kind = 'simple'
join public.order_items as item
  on item.organization_id = state.organization_id
 and item.product_id = link.product_id
 and item.is_current
join public.orders as orders
  on orders.id = item.order_id
left join public.ml_listings as listing
  on listing.id = item.ml_listing_id
left join public.ml_listing_variations as variation
  on variation.ml_listing_id = item.ml_listing_id
 and variation.variation_id = item.variation_id
 and variation.is_current
where
  -- Só vendas posteriores ao retrato de estoque vigente. É isto que faz a
  -- baixa expirar sozinha quando uma planilha nova é importada.
  orders.date_created > state.checked_at
  -- Cancelado não consome estoque; como isto é uma view, o cancelamento
  -- posterior se autocorrige sem precisar de estorno.
  and orders.status <> 'cancelled'
  -- Full não desconta do físico.
  and coalesce(variation.inventory_id, listing.inventory_id) is null
group by state.organization_id, state.sku_key, state.warehouse_key;

revoke all on public.current_ml_sale_deductions from public, anon;
grant select on public.current_ml_sale_deductions to authenticated;

-- ------------------------------------------------------------
-- 3. MOVIMENTOS MANUAIS VIGENTES
-- ------------------------------------------------------------

create or replace view public.current_stock_manual_movements
with (security_invoker = true)
as
select
  movement.organization_id,
  movement.sku_key,
  movement.warehouse_key,
  sum(movement.quantity)::numeric as quantity,
  max(movement.occurred_at) as last_movement_at
from public.stock_movements as movement
join public.upseller_stock_states as state
  on state.organization_id = movement.organization_id
 and state.sku_key = movement.sku_key
 and state.warehouse_key = movement.warehouse_key
-- Mesma expiração: movimento anterior ao retrato vigente já está refletido
-- na planilha importada.
where movement.occurred_at > state.checked_at
group by movement.organization_id, movement.sku_key, movement.warehouse_key;

revoke all on public.current_stock_manual_movements from public, anon;
grant select on public.current_stock_manual_movements to authenticated;

-- ------------------------------------------------------------
-- 4. RPC DE SAÍDA MANUAL
-- ------------------------------------------------------------

create or replace function public.register_stock_movement(
  target_organization_id uuid,
  target_sku text,
  requested_quantity numeric,
  requested_kind text default 'manual_exit',
  requested_reason text default null,
  requested_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_sku_key text;
  resolved_source_sku text;
  signed_quantity numeric;
  new_id uuid;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if requested_kind not in ('manual_exit', 'manual_entry', 'adjustment') then
    raise exception 'invalid_movement_kind';
  end if;

  if requested_quantity is null or requested_quantity <= 0 then
    raise exception 'invalid_quantity';
  end if;

  select state.sku_key, max(state.source_sku)
  into resolved_sku_key, resolved_source_sku
  from public.upseller_stock_states as state
  where state.organization_id = target_organization_id
    and upper(btrim(state.sku_key)) = upper(btrim(target_sku))
  group by state.sku_key;

  if resolved_sku_key is null then
    raise exception 'sku_not_found';
  end if;

  -- Saída é negativa; entrada e ajuste positivos.
  signed_quantity := case
    when requested_kind = 'manual_exit' then -requested_quantity
    else requested_quantity
  end;

  insert into public.stock_movements (
    organization_id, sku_key, source_sku, warehouse_key,
    movement_kind, quantity, reason, note, created_by
  ) values (
    target_organization_id, resolved_sku_key, resolved_source_sku, 'ESTOQUE LOJA',
    requested_kind, signed_quantity, requested_reason, requested_note, (select auth.uid())
  )
  returning id into new_id;

  return jsonb_build_object(
    'id', new_id,
    'skuKey', resolved_sku_key,
    'sourceSku', resolved_source_sku,
    'quantity', signed_quantity
  );
end;
$$;

revoke all on function public.register_stock_movement(uuid, text, numeric, text, text, text)
from public, anon;
grant execute on function public.register_stock_movement(uuid, text, numeric, text, text, text)
to authenticated;
