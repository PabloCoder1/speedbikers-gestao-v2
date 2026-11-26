-- D-878: a 1ª venda da análise de compra pelos índices do SKU.
--
-- Depois da D-877, quase todo o tempo de get_purchase_analysis estava na 1ª
-- venda. Na Shopee, o plano percorria todos os pedidos válidos da loja e
-- provava os itens de cada um (~200 ms e ~100 mil páginas para 50 SKUs). No
-- ML, lia todos os dias de cada SKU para tirar o mínimo.
--
-- Agora os itens Shopee dos SKUs pedidos saem do índice (organization_id,
-- sku_id) e cruzam com os pedidos por hash, e o primeiro dia com venda no ML
-- é a primeira linha do índice (organization_id, sku_id, metric_date). As
-- regras são as mesmas: Shopee só live e VALIDA, ML com units_sold > 0, e o
-- menor dos dois. O resto da função não muda. create or replace preserva os
-- grants; o comentário é refeito igual.

create or replace function public.get_purchase_analysis(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_date_to date default null,
  p_exclude_order_id uuid default null,
  p_supplier_id uuid default null,
  -- Falso = só os extras: a Reposição já tem os ingredientes da sugestão na
  -- linha da visão e não paga a segunda varredura do catálogo.
  p_incluir_sugestao boolean default true
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_ate date := coalesce(p_date_to, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if coalesce(cardinality(p_sku_ids), 0) > 500 then
    raise exception 'no maximo 500 skus por leitura';
  end if;

  if coalesce(cardinality(p_sku_ids), 0) = 0 then
    return jsonb_build_object('data', v_ate, 'linhas', '[]'::jsonb,
      'new_product_days', coalesce((select r.new_product_days from public.purchase_review_settings r where r.organization_id = p_organization_id), 60),
      'margem_minima', coalesce((select t.margin_floor from public.central_thresholds t where t.organization_id = p_organization_id), 0.10));
  end if;

  return (
  with
  alvo as materialized (
    select s.id as sku_id, s.sku, s.title, s.supplier_brand, s.purchase_cost,
           s.created_at, s.is_discontinued, s.stock_is_virtual, s.kind
    from public.skus s
    where s.organization_id = p_organization_id
      and s.id = any (p_sku_ids)
  ),
  sugestao as materialized (
    select o.*
    from public.get_purchase_suggestions(p_organization_id, v_ate, null, null, 1000000, 0, null) o
    where coalesce(p_incluir_sugestao, true)
      and o.sku_id in (select a.sku_id from alvo a)
  ),
  -- D-878: os itens Shopee dos SKUs pedidos saem primeiro pelo índice
  -- (organization_id, sku_id) e só então encontram o pedido. Pela view
  -- shopee_sales_items, o filtro de organização caía no pedido, e o plano
  -- percorria todos os pedidos válidos da loja para provar os itens de cada um.
  -- A organização do item é a da loja, e a do pedido também (chaves
  -- estrangeiras por loja e organização), então o recorte é o mesmo.
  itens_shopee as materialized (
    select i.shopee_shop_id, i.order_sn, i.sku_id
    from public.shopee_order_items i
    where i.organization_id = p_organization_id
      and i.sku_id in (select a.sku_id from alvo a)
  ),
  primeira_venda as (
    select x.sku_id, min(x.dia) as dia
    from (
      -- D-878: o primeiro dia com venda no ML sai do índice
      -- (organization_id, sku_id, metric_date), e não de todos os dias do SKU.
      select a.sku_id, ml.dia
      from alvo a
      cross join lateral (
        select m.metric_date as dia
        from public.daily_sku_metrics m
        where m.organization_id = p_organization_id
          and m.sku_id = a.sku_id
          and m.units_sold > 0
        order by m.metric_date
        limit 1
      ) ml
      union all
      select it.sku_id, min(v.dia)
      from itens_shopee it
      join public.shopee_sales_orders v
        on v.shopee_shop_id = it.shopee_shop_id and v.order_sn = it.order_sn
      where v.organization_id = p_organization_id
        and v.environment = 'live'
        and v.situacao = 'VALIDA'
      group by it.sku_id
    ) x
    group by x.sku_id
  ),
  -- ---- Ruptura nos últimos 30 dias ----
  dias as (
    select d::date as dia from generate_series(v_ate - 29, v_ate, interval '1 day') d
  ),
  saldo_local as (
    select b.sku_id, sum(b.quantity) as local
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
      and b.sku_id in (select a.sku_id from alvo a)
    group by b.sku_id
  ),
  movimentos as (
    select m.sku_id, (m.occurred_at at time zone 'America/Sao_Paulo')::date as dia, sum(m.qty_delta) as delta
    from public.stock_movements m
    where m.organization_id = p_organization_id
      and m.location_kind = 'LOCAL'
      and m.sku_id in (select a.sku_id from alvo a)
      and m.occurred_at >= ((v_ate - 29)::timestamp at time zone 'America/Sao_Paulo')
    group by 1, 2
  ),
  -- O Full de cada dia pela definição CANÔNICA (D-173/D-204), aplicada no fim
  -- do dia: a última captura de cada bucket (`ml_account_id`, `inventory_id`)
  -- até ali, com a janela de frescor de 3 days.
  full_dia as (
    select a.sku_id, d.dia, coalesce(sum(q.quantity), 0) > 0 as positivo
    from alvo a
    cross join dias d
    left join lateral (
      select distinct on (f.ml_account_id, f.inventory_id) f.quantity
      from public.fulfillment_stock_snapshots f
      where f.organization_id = p_organization_id
        and f.sku_id = a.sku_id
        and f.captured_at < ((d.dia + 1)::timestamp at time zone 'America/Sao_Paulo')
        and f.captured_at >= ((d.dia + 1)::timestamp at time zone 'America/Sao_Paulo') - interval '3 days'
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) q on true
    group by a.sku_id, d.dia
  ),
  com_captura as (
    select distinct f.sku_id
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.sku_id in (select a.sku_id from alvo a)
      and f.captured_at >= ((v_ate - 29)::timestamp at time zone 'America/Sao_Paulo') - interval '3 days'
  ),
  tem_fonte as (
    select a.sku_id,
      not a.stock_is_virtual
      and (exists (select 1 from saldo_local s where s.sku_id = a.sku_id)
           or exists (select 1 from com_captura c where c.sku_id = a.sku_id)) as conhecido
    from alvo a
  ),
  -- D-877: os movimentos depois do fim da janela (p_date_to no passado) também
  -- saem do saldo atual, como no filtro antigo `m.dia > d.dia`, sem teto.
  depois_do_fim as (
    select m.sku_id, sum(m.delta) as delta
    from movimentos m
    where m.dia > v_ate
    group by m.sku_id
  ),
  -- O LOCAL no fim de cada dia é o saldo atual menos tudo o que entrou e saiu
  -- DEPOIS daquele dia. D-877: a soma "depois do dia" sai de uma janela
  -- acumulada, do último dia para trás, e não de uma subconsulta por
  -- (SKU, dia) que relia os movimentos do SKU 30 vezes.
  local_fim_do_dia as (
    select a.sku_id, d.dia,
      coalesce(s.local, 0)
        - coalesce(dep.delta, 0)
        - coalesce(sum(coalesce(m.delta, 0)) over (
            partition by a.sku_id order by d.dia desc
            rows between unbounded preceding and 1 preceding), 0) as local_fim
    from alvo a
    cross join dias d
    left join saldo_local s on s.sku_id = a.sku_id
    left join movimentos m on m.sku_id = a.sku_id and m.dia = d.dia
    left join depois_do_fim dep on dep.sku_id = a.sku_id
  ),
  ruptura as (
    select l.sku_id, count(*) filter (
      where l.local_fim <= 0
        and not coalesce((
          select f.positivo from full_dia f
          where f.sku_id = l.sku_id and f.dia = l.dia), false)
    )::integer as dias
    from local_fim_do_dia l
    group by l.sku_id
  ),
  -- ---- Pedidos sobrepostos (rascunho/aprovado, fora do trânsito) ----
  abertos as (
    select i.sku_id, o.id, o.order_number, o.status, sum(i.quantity_ordered) as quantidade
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    where i.organization_id = p_organization_id
      and i.sku_id in (select a.sku_id from alvo a)
      and o.status in ('DRAFT', 'APPROVED')
      and (p_exclude_order_id is null or o.id <> p_exclude_order_id)
    group by i.sku_id, o.id, o.order_number, o.status
  ),
  ultima_compra as (
    select distinct on (i.sku_id)
      i.sku_id, i.unit_cost, o.currency, o.created_at, o.order_number, sp.name as fornecedor
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    left join public.suppliers sp on sp.id = o.supplier_id
    where i.organization_id = p_organization_id
      and i.sku_id in (select a.sku_id from alvo a)
      and o.status in ('ORDERED', 'RECEIVED')
      and (p_exclude_order_id is null or o.id <> p_exclude_order_id)
    order by i.sku_id, o.created_at desc
  ),
  regra as (
    select ss.* from public.supplier_skus ss
    where p_supplier_id is not null
      and ss.supplier_id = p_supplier_id
      and ss.sku_id in (select a.sku_id from alvo a)
  ),
  preferido as (
    select ss.sku_id, sp.id as supplier_id, sp.name
    from public.supplier_skus ss
    join public.suppliers sp on sp.id = ss.supplier_id
    where ss.is_preferred and ss.sku_id in (select a.sku_id from alvo a)
  )
  select jsonb_build_object(
    'data', v_ate,
    'new_product_days', coalesce((select r.new_product_days from public.purchase_review_settings r where r.organization_id = p_organization_id), 60),
    'margem_minima', coalesce((select t.margin_floor from public.central_thresholds t where t.organization_id = p_organization_id), 0.10),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku_id', a.sku_id, 'sku', a.sku, 'title', a.title, 'supplier_brand', a.supplier_brand,
        'purchase_cost', a.purchase_cost, 'stock_is_virtual', a.stock_is_virtual,
        -- Fora do universo da reposição (sem saldo, venda nem anúncio): os
        -- ingredientes da sugestão vêm nulos e a tela diz "fora da reposição".
        'na_reposicao', case when coalesce(p_incluir_sugestao, true) then s.sku_id is not null end,
        'local_quantity', s.local_quantity, 'reservado', s.reservado, 'transito', s.transito,
        'full_quantity', s.full_quantity,
        'units_15d', s.units_15d, 'units_30d', s.units_30d, 'units_60d', s.units_60d, 'units_90d', s.units_90d,
        'history_days_90', s.history_days_90, 'abc_class', s.abc_class,
        'units_30d_shopee', s.units_30d_shopee, 'units_90d_shopee', s.units_90d_shopee,
        'is_discontinued', a.is_discontinued,
        'kind', a.kind,
        'days_since_created', (v_ate - (a.created_at at time zone 'America/Sao_Paulo')::date),
        'first_sale_date', pv.dia,
        'days_since_first_sale', case when pv.dia is null then null else v_ate - pv.dia end,
        'stockout_days_30', case when tf.conhecido then r.dias end,
        'other_open_quantity', coalesce((select sum(ab.quantidade) from abertos ab where ab.sku_id = a.sku_id), 0),
        'other_open_orders', coalesce((
          select jsonb_agg(jsonb_build_object('id', ab.id, 'order_number', ab.order_number,
                                              'status', ab.status, 'quantity', ab.quantidade)
                           order by ab.order_number)
          from abertos ab where ab.sku_id = a.sku_id), '[]'::jsonb),
        'last_purchase', (
          select jsonb_build_object('unit_cost', u.unit_cost, 'currency', u.currency, 'at', u.created_at,
                                    'order_number', u.order_number, 'supplier', u.fornecedor)
          from ultima_compra u where u.sku_id = a.sku_id),
        'supplier_rule', (
          select jsonb_build_object('supplier_code', g.supplier_code, 'unit_cost', g.unit_cost, 'currency', g.currency,
                                    'minimum_order_quantity', g.minimum_order_quantity, 'pack_multiple', g.pack_multiple,
                                    'lead_time_days', g.lead_time_days)
          from regra g where g.sku_id = a.sku_id),
        'preferred_supplier', (
          select jsonb_build_object('id', pf.supplier_id, 'name', pf.name)
          from preferido pf where pf.sku_id = a.sku_id)
      ) order by a.sku)
      from alvo a
      left join sugestao s on s.sku_id = a.sku_id
      left join primeira_venda pv on pv.sku_id = a.sku_id
      left join ruptura r on r.sku_id = a.sku_id
      left join tem_fonte tf on tf.sku_id = a.sku_id), '[]'::jsonb)
  )
  );
end;
$$;

comment on function public.get_purchase_analysis(uuid, uuid[], date, uuid, uuid, boolean) is
  'Ingredientes da avaliação de compra (D-721) para até 500 SKUs: as colunas de get_purchase_suggestions, idade comercial (1ª venda ML/Shopee e cadastro), dias dos últimos 30 com o vendável zerado (LOCAL do ledger no fim do dia e Full das capturas de 3 dias; nulo sem fonte), pedidos sobrepostos em rascunho/aprovado (fora p_exclude_order_id), a última compra e as regras do fornecedor p_supplier_id. p_incluir_sugestao falso: só os extras, na_reposicao nulo. Também o piso de margem (D-410) e os dias de produto recente. security invoker.';

revoke all on function public.get_purchase_analysis(uuid, uuid[], date, uuid, uuid, boolean) from public, anon;
grant execute on function public.get_purchase_analysis(uuid, uuid[], date, uuid, uuid, boolean) to authenticated, service_role;
