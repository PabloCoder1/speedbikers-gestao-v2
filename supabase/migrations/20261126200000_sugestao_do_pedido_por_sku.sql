-- A sugestão do pedido de compra calculada só para os SKUs pedidos.
--
-- get_purchase_order_suggestions (o "trazer da Reposição" por marca e a coluna
-- de sugestão do pedido novo, por SKU) chamava get_purchase_suggestions para o
-- catálogo inteiro e depois recortava. Agora passa p_sku_ids (D-879): a lista
-- do chamador ou, sem ela, os SKUs da marca. A marca continua indo como
-- p_supplier_brand, com a mesma igualdade, então o recorte é o mesmo.
-- O total, as linhas e a ordem não mudam. Depende da correção da D-879
-- (20261126190000) para listas curtas.

CREATE OR REPLACE FUNCTION public.get_purchase_order_suggestions(p_organization_id uuid, p_sku_ids uuid[] DEFAULT NULL::uuid[], p_supplier_brand text DEFAULT NULL::text, p_scope text DEFAULT NULL::text, p_limit integer DEFAULT 500, p_date_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  marca text := nullif(btrim(coalesce(p_supplier_brand, '')), '');
  resultado jsonb;
begin
  if (p_sku_ids is null or cardinality(p_sku_ids) = 0) and marca is null then
    return jsonb_build_object('total', 0, 'linhas', '[]'::jsonb);
  end if;

  with sugestao as (
    select o.*
    -- Só os SKUs pedidos; sem lista, os da marca, pela mesma igualdade que
    -- get_purchase_suggestions aplica a p_supplier_brand. A sugestão de cada
    -- SKU não muda (D-879), e a ordem relativa também não.
    from public.get_purchase_suggestions(
           p_organization_id, p_date_to, marca, null, 1000000, 0, null,
           case
             when p_sku_ids is not null and cardinality(p_sku_ids) > 0 then p_sku_ids
             else array(select k.id from public.skus k
                        where k.organization_id = p_organization_id
                          and k.supplier_brand = marca)
           end
         ) with ordinality as o(
           sku_id, sku, title, supplier_brand, purchase_cost, stock_is_virtual,
           local_quantity, reservado, transito, full_quantity,
           units_15d, units_30d, units_60d, units_90d, history_days_90,
           abc_class, coverage_days, state, suggested_quantity, total_count,
           units_30d_shopee, units_90d_shopee, ordem
         )
  ),
  recorte as (
    select s.*
    from sugestao s
    where (p_sku_ids is null or cardinality(p_sku_ids) = 0 or s.sku_id = any (p_sku_ids))
      and (marca is null
           or p_scope is null
           or (p_scope = 'comprar_agora' and s.state in ('RUPTURA', 'COMPRA_URGENTE') and s.suggested_quantity > 0)
           or (p_scope = 'com_sugestao' and s.suggested_quantity > 0))
  ),
  pagina as (
    select r.*
    from recorte r
    order by r.ordem
    limit greatest(least(coalesce(p_limit, 500), 500), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from recorte),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku_id', p.sku_id,
               'sku', p.sku,
               'title', p.title,
               'supplier_brand', p.supplier_brand,
               'purchase_cost', p.purchase_cost,
               'is_imported', k.is_imported,
               'state', p.state,
               'suggested_quantity', p.suggested_quantity,
               'coverage_days', p.coverage_days,
               'units_30d', p.units_30d,
               'units_30d_shopee', p.units_30d_shopee,
               'aproveitavel', case when p.stock_is_virtual then null
                                    else p.local_quantity + p.full_quantity + p.transito - p.reservado end)
             order by p.ordem)
      from pagina p
      left join public.skus k on k.id = p.sku_id), '[]'::jsonb)
  )
  into resultado;

  return resultado;
end
$function$;
