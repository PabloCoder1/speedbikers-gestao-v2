-- D-871: o Full do dashboard do SKU deixa de virar zero quando nao ha captura.
--
-- A mesma regra da D-870 (faixa de /estoque), agora em `get_sku_dashboard`, que
-- alimenta o detalhe do SKU e a inspecao de /produtos. Sem nenhuma captura do
-- Full da organizacao nos 3 dias da janela canonica (D-173), `full_quantity`
-- vem nulo, e as telas mostram "—". Com captura, o SKU sem Full continua 0.
--
-- Mesma assinatura e mesmo retorno: `create or replace` preserva os grants, e a
-- tela anterior continua funcionando (formatCount(null) ja imprime "—").

create or replace function public.get_sku_dashboard(
  p_organization_id uuid,
  p_sku_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  local_quantity numeric,
  reservado_quantity numeric,
  transito_quantity numeric,
  full_quantity numeric,
  units_sold bigint,
  gross_revenue numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with balances as (
    select location_kind, quantity
    from public.inventory_balances
    where organization_id = p_organization_id and sku_id = p_sku_id
  ),
  sales as (
    select
      coalesce(sum(units_sold), 0)::bigint as units_sold,
      coalesce(sum(gross_revenue), 0) as gross_revenue
    from public.daily_sku_metrics
    where organization_id = p_organization_id
      and sku_id = p_sku_id
      and metric_date between p_date_from and p_date_to
  ),
  latest_full as (
    -- Definicao CANONICA de "Full atual" (D-173): bucket `inventory_id` e
    -- janela de frescor de 3 dias.
    --
    -- Antes agrupava por `(ml_account_id, item_id, variation_id)`, que e' uma
    -- TERCEIRA forma -- nem a canonica, nem a de `get_purchase_suggestions`.
    -- Hoje ela devolve o mesmo numero porque `inventory_id` e o par
    -- (item, variacao) estao 1:1 nos dados (2.165 para 2.165, medido em
    -- 02/09/2026). Nao ha nada que garanta que continuem: a migration
    -- `20260831210151_fulfillment_overview_and_full_grain_fix.sql` existe
    -- justamente porque um grao errado ja custou **12 SKUs aparecendo como
    -- "sem Full" tendo Full, e o total 15,6% menor**.
    select distinct on (f.ml_account_id, f.inventory_id) f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id and f.sku_id = p_sku_id
      and f.captured_at >= now() - interval '3 days'
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_total as (
    -- Sem NENHUMA captura da organizacao na janela, o Full e desconhecido
    -- (nulo), nao zero (D-871, a regra de D-870). Com captura, o SKU que nao
    -- aparece nela esta fora do Full, e a soma vazia e zero de verdade.
    select case
             when exists (select 1 from public.fulfillment_stock_snapshots c
                          where c.organization_id = p_organization_id
                            and c.captured_at >= now() - interval '3 days')
             then coalesce(sum(quantity), 0)
           end as full_quantity
    from latest_full
  )
  select
    coalesce((select quantity from balances where location_kind = 'LOCAL'), 0) as local_quantity,
    coalesce((select quantity from balances where location_kind = 'RESERVADO'), 0) as reservado_quantity,
    coalesce((select quantity from balances where location_kind = 'TRANSITO'), 0) as transito_quantity,
    full_total.full_quantity,
    sales.units_sold,
    sales.gross_revenue
  from sales cross join full_total
$$;
