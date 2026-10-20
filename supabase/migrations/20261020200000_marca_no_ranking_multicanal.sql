-- ============================================================
-- D-613 -- a marca no ranking do "Todos" de /vendas (contrato C-75, pedido
-- do A2 para a tela da marca, a fatia do C-72).
--
-- `get_marketplace_sku_sales` (C-59, D-439) ganha NO FIM `p_supplier_brand`
-- e `p_sem_marca`, os nomes e a regra do C-72 e do ML (D-237). Cada linha e
-- um SKU, entao o recorte so escolhe quais linhas entram: nenhum numero de
-- uma linha muda, e as compras do SKU continuam somaveis na linha. Sem
-- recorte, nada muda. Drop + create: os parametros novos mudam a assinatura.
-- ============================================================

drop function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer);

create function public.get_marketplace_sku_sales(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null,
  p_sku_ids uuid[] default null,
  p_ordem text default 'receita',
  p_limit integer default 50,
  p_offset integer default 0,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  sku_id uuid,
  sku text,
  sku_title text,
  unidades_ml bigint,
  receita_ml numeric,
  compras_ml bigint,
  unidades_shopee bigint,
  receita_shopee numeric,
  itens_shopee_sem_receita bigint,
  compras_shopee bigint,
  unidades bigint,
  receita_bruta numeric,
  compras bigint,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
  v_sem_marca boolean := coalesce(p_sem_marca, false);
  v_recorte boolean := p_supplier_brand is not null or coalesce(p_sem_marca, false);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  if coalesce(p_ordem, 'receita') not in ('receita', 'unidades') then
    raise exception 'ordem invalida: % (use receita ou unidades)', p_ordem;
  end if;

  return query
  with
  ml as (
    select m.sku_id,
           sum(m.units_sold)::bigint as unidades,
           sum(m.gross_revenue) as receita,
           sum(m.purchases_count)::bigint as compras
    from public.daily_sku_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
      and (p_sku_ids is null or m.sku_id = any (p_sku_ids))
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  shopee as (
    select it.sku_id,
           sum(it.quantity)::bigint as unidades,
           sum(it.receita_item) as receita,
           count(*) filter (where it.receita_item is null)::bigint as sem_receita,
           count(distinct (it.shopee_shop_id, it.order_sn))::bigint as compras
    from public.shopee_sales_items it
    where 'SHOPEE' = any (v_marketplaces)
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and (p_sku_ids is null or it.sku_id = any (p_sku_ids))
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.sku_id
  ),
  juntos as (
    -- O balde sem SKU (NULO) dos dois lados fica numa linha so. FULL JOIN
    -- exige igualdade comum ("is not distinct from" e recusado): o nulo vira
    -- um sentinela que nenhum uuid real e, so para casar.
    select
      coalesce(ml.sku_id, sh.sku_id) as sku_id,
      ml.unidades as unidades_ml, ml.receita as receita_ml, ml.compras as compras_ml,
      sh.unidades as unidades_shopee, sh.receita as receita_shopee, sh.sem_receita, sh.compras as compras_shopee
    from ml
    full join shopee sh
      on coalesce(sh.sku_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(ml.sku_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  totais as (
    select
      j.*,
      (coalesce(j.unidades_ml, 0) + coalesce(j.unidades_shopee, 0))::bigint as unidades,
      -- Receita conhecida dos dois lados; o desconhecido da Shopee esta em
      -- itens_shopee_sem_receita. Sem nenhuma receita conhecida: NULO.
      case when j.receita_ml is null and j.receita_shopee is null then null
           else coalesce(j.receita_ml, 0) + coalesce(j.receita_shopee, 0) end as receita,
      (coalesce(j.compras_ml, 0) + coalesce(j.compras_shopee, 0))::bigint as compras
    from juntos j
  )
  select
    t.sku_id, s.sku, s.title,
    t.unidades_ml, round(t.receita_ml, 2), t.compras_ml,
    t.unidades_shopee, round(t.receita_shopee, 2), t.sem_receita, t.compras_shopee,
    t.unidades, round(t.receita, 2), t.compras,
    count(*) over ()
  from totais t
  left join public.skus s on s.id = t.sku_id
  -- D-613: o recorte de marca e do SKU da linha (a regra do ML, D-237; o
  -- "sem marca" leva o balde sem SKU). A linha nao muda: so quais entram, e o
  -- total_count e o do recorte.
  where not v_recorte
     or (
       case when v_sem_marca
         then t.sku_id is null or s.supplier_brand is null
         else s.supplier_brand = p_supplier_brand
       end
     )
  order by
    case when coalesce(p_ordem, 'receita') = 'receita' then t.receita end desc nulls last,
    t.unidades desc,
    s.sku nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;


comment on function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer, text, boolean) is
  'Vendas por SKU entre marketplaces (D-439, C-59): unidades, receita bruta e compras por marketplace e o total no SQL; o balde sem SKU (sku_id NULO) numa linha; itens Shopee de receita desconhecida contados; sandbox fora; paginada (ate 500) com total_count. p_marketplaces nulo = so ML. Recorte de marca (D-613, C-75): p_supplier_brand / p_sem_marca escolhem os SKUs da linha.';

revoke all on function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer, text, boolean) from public, anon;
grant execute on function public.get_marketplace_sku_sales(uuid, date, date, text[], uuid[], uuid[], text, integer, integer, text, boolean) to authenticated;
