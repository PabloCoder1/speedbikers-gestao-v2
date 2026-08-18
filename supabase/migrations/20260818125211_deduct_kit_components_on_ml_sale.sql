-- ============================================================
-- BAIXA DE COMPONENTES QUANDO O KIT VENDE
-- ============================================================
--
-- Aplicada em produção como 20260818125211.
--
-- current_ml_sale_deductions só descontava vínculos 'simple'. Uma venda
-- de kit não baixava componente nenhum — 159 produtos e 1.413 unidades em
-- 30 dias ficavam fora.
--
-- O kit não tem estoque físico próprio: ele É a combinação dos
-- componentes. Vender 1 kit A.B com A x1 e B x2 consome 1 de A e 2 de B.
--
-- Reaproveita a mesma definição de composição confiável já usada em
-- private.get_purchase_planning_signals e get_stock_product_signals:
-- todo componente precisa existir no estoque e nenhum componente pode ser
-- ele mesmo um kit (aninhamento não é suportado). Kit sem composição
-- confiável NÃO desconta nada — preferimos estoque desatualizado a
-- estoque errado, porque o errado é invisível.
--
-- As demais regras seguem idênticas às da venda simples: só vendas
-- posteriores ao retrato vigente (auto-expiração na próxima importação),
-- cancelado não consome, e Full não desconta do físico.
--
-- Verificado em produção: o kit 20083.4064.1737 vendeu 77 unidades em 30
-- dias e cada um dos seus três componentes recebe consumo de 77; o kit
-- 15031.15032 vendeu 90 e ambos os componentes recebem 90.

create or replace view public.current_ml_sale_deductions
with (security_invoker = true)
as
with reliable_kits as (
  select
    component.kit_sku_key,
    bool_and(component_state.sku_key is not null)
      and not bool_or(nested_kit.kit_sku_key is not null) as reliable
  from public.upseller_kit_components as component
  left join (
    select distinct state.organization_id, state.sku_key
    from public.upseller_stock_states as state
  ) as component_state
    on component_state.organization_id = component.organization_id
   and component_state.sku_key = component.component_sku_key
  left join public.upseller_kits as nested_kit
    on nested_kit.organization_id = component.organization_id
   and nested_kit.kit_sku_key = component.component_sku_key
   and nested_kit.is_current
  where component.is_current
  group by component.kit_sku_key
),

sold_lines as (
  select
    item.organization_id,
    link.source_sku_key,
    link.source_kind,
    item.quantity,
    orders.date_created,
    orders.id as order_id
  from public.order_items as item
  join public.orders as orders
    on orders.id = item.order_id
  join public.product_inventory_links as link
    on link.organization_id = item.organization_id
   and link.product_id = item.product_id
   and link.source = 'upseller'
   and link.is_active
  left join public.ml_listings as listing
    on listing.id = item.ml_listing_id
  left join public.ml_listing_variations as variation
    on variation.ml_listing_id = item.ml_listing_id
   and variation.variation_id = item.variation_id
   and variation.is_current
  where item.is_current
    and orders.status <> 'cancelled'
    -- Full não desconta do físico: a unidade saiu do depósito quando foi
    -- enviada ao Mercado Livre, não quando vendeu.
    and coalesce(variation.inventory_id, listing.inventory_id) is null
),

-- Venda de produto simples consome o próprio SKU.
simple_consumption as (
  select
    sold_lines.organization_id,
    sold_lines.source_sku_key as sku_key,
    sold_lines.quantity::numeric as quantity,
    sold_lines.date_created,
    sold_lines.order_id
  from sold_lines
  where sold_lines.source_kind = 'simple'
),

-- Venda de kit consome cada componente pela quantidade requerida.
kit_consumption as (
  select
    sold_lines.organization_id,
    component.component_sku_key as sku_key,
    (sold_lines.quantity * component.required_quantity)::numeric as quantity,
    sold_lines.date_created,
    sold_lines.order_id
  from sold_lines
  join reliable_kits
    on reliable_kits.kit_sku_key = sold_lines.source_sku_key
   and reliable_kits.reliable
  join public.upseller_kit_components as component
    on component.organization_id = sold_lines.organization_id
   and component.kit_sku_key = sold_lines.source_sku_key
   and component.is_current
  where sold_lines.source_kind = 'kit'
),

consumption as (
  select * from simple_consumption
  union all
  select * from kit_consumption
)

select
  state.organization_id,
  state.sku_key,
  state.warehouse_key,
  sum(consumption.quantity)::numeric as quantity,
  max(consumption.date_created) as last_sale_at,
  count(*)::bigint as sale_lines
from public.upseller_stock_states as state
join consumption
  on consumption.organization_id = state.organization_id
 and consumption.sku_key = state.sku_key
-- Auto-expiração: só conta o que veio depois do retrato vigente. Quando a
-- planilha nova entra, checked_at avança e isto zera sozinho.
where consumption.date_created > state.checked_at
group by state.organization_id, state.sku_key, state.warehouse_key;

revoke all on public.current_ml_sale_deductions from public, anon;
grant select on public.current_ml_sale_deductions to authenticated;
