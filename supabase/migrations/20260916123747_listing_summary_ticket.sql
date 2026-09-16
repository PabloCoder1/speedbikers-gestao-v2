-- ============================================================
-- `get_listing_dashboard_summary` ganha compras por pack, ticket medio e
-- preco medio praticado (D-357, Dashboard do Anuncio).
--
-- Os tres ja sao canonicos em docs/METRICS.md 5.2 com `anuncio` entre as
-- granularidades aprovadas; nenhuma metrica nova foi inventada. O Dashboard de
-- SKU mostra os tres desde D-227; o do anuncio nao tinha de onde le-los.
--
-- ------------------------------------------------------------
-- POR QUE A COMPRA POR PACK VEM DA FONTE, E NAO DA SOMA DAS LINHAS DIARIAS
-- ------------------------------------------------------------
-- `daily_listing_metrics` tem uma linha por (anuncio, VARIACAO, dia), e o
-- `purchases_count` de cada linha e distinto DENTRO dela. Somar entre dias e
-- exato (um pack nao atravessa dias -- 172.624 packs medidos em D-227), mas
-- somar entre VARIACOES do mesmo anuncio nao e: um pack que leva duas
-- variacoes do mesmo MLB conta duas vezes. METRICS.md 5.1 manda calcular
-- contagem distinta "diretamente no grao solicitado" -- entao a contagem sai
-- de `orders` + `order_items`, com o mesmo predicado de venda valida e a mesma
-- data de negocio de `private.compute_daily_sales_metrics`.
--
-- As razoes usam a receita e as unidades que a tela JA imprime (soma das
-- linhas diarias), sobre as SOMAS do periodo -- nunca media das razoes
-- diarias. Denominador zero devolve NULL, e a tela imprime "--".
--
-- Entra por `order_items_listing_idx (ml_account_id, item_id, ...)` e pela
-- chave primaria de `orders`; nenhum indice novo.
--
-- Colunas NOVAS no FIM do retorno, e a assinatura de argumentos nao muda:
-- quem le por nome (tela, Copiloto) segue funcionando, e o Preview de PR sem
-- esta migration so ve as tres colunas ausentes.
-- ============================================================

drop function public.get_listing_dashboard_summary(uuid, uuid, text, date, date);

create function public.get_listing_dashboard_summary(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_item_id text,
  p_date_from date,
  p_date_to date
)
returns table (
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  visits bigint,
  days_observed integer,
  conversion numeric,
  purchases_count bigint,
  average_ticket numeric,
  average_selling_price numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with m as (
    select coalesce(sum(dm.units_sold), 0)::bigint as units,
           coalesce(round(sum(dm.gross_revenue), 2), 0) as revenue,
           coalesce(sum(dm.orders_count), 0)::bigint as orders
    from public.daily_listing_metrics dm
    where dm.organization_id = p_organization_id
      and dm.ml_account_id = p_ml_account_id
      and dm.mlb_id = p_item_id
      and dm.metric_date between p_date_from and p_date_to
  ),
  v as (
    select coalesce(sum(dv.visits), 0)::bigint as total_visits,
           count(*)::integer as days_observed
    from public.daily_listing_visits dv
    where dv.organization_id = p_organization_id
      and dv.ml_account_id = p_ml_account_id
      and dv.item_id = p_item_id
      and dv.metric_date between p_date_from and p_date_to
  ),
  oo as (
    -- Mesmo recorte do denominador: pedidos dos dias com visita observada.
    select coalesce(sum(coalesce(dm.orders_count, 0)), 0)::bigint as orders_observed
    from public.daily_listing_visits dv
    left join public.daily_listing_metrics dm
      on dm.organization_id = dv.organization_id
     and dm.ml_account_id = dv.ml_account_id
     and dm.mlb_id = dv.item_id
     and dm.metric_date = dv.metric_date
    where dv.organization_id = p_organization_id
      and dv.ml_account_id = p_ml_account_id
      and dv.item_id = p_item_id
      and dv.metric_date between p_date_from and p_date_to
  ),
  pk as (
    -- `pedidos_por_pack` no grao (anuncio, periodo), direto da fonte.
    select count(distinct case
             when o.pack_id is null then 'order:' || o.id::text
             else 'pack:' || o.pack_id::text
           end)::bigint as purchases
    from public.order_items oi
    join public.orders o
      on o.id = oi.order_id
     and o.organization_id = oi.organization_id
     and o.ml_account_id = oi.ml_account_id
    where oi.ml_account_id = p_ml_account_id
      and oi.item_id = p_item_id
      and o.organization_id = p_organization_id
      and p_date_from <= p_date_to
      and o.status in ('paid', 'partially_refunded')
      and o.date_created >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and o.date_created < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  )
  select m.units, m.revenue, m.orders, v.total_visits, v.days_observed,
         round(oo.orders_observed::numeric / nullif(v.total_visits, 0), 4) as conversion,
         pk.purchases,
         round(m.revenue / nullif(pk.purchases, 0), 2) as average_ticket,
         round(m.revenue / nullif(m.units, 0), 2) as average_selling_price
  from m, v, oo, pk
$$;

comment on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) is
  'Resumo de vendas + trafego de UM anuncio (Dashboard 360º, D-168; conversao corrigida em D-170; compras, ticket e preco medio em D-357). conversion e FRACAO sobre os pedidos dos DIAS COM VISITA OBSERVADA, NULL sem visita. purchases_count e COUNT DISTINCT de pack/pedido direto de orders+order_items no grao (anuncio, periodo) -- somar as linhas por variacao contaria o mesmo pack duas vezes. average_ticket = receita / compras e average_selling_price = receita / unidades, sobre as somas, NULL com denominador zero. security invoker: RLS filtra antes da soma.';

revoke all on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) from public, anon;
grant execute on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) to authenticated, service_role;
