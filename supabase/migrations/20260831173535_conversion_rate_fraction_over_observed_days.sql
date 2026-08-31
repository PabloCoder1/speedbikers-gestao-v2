-- ============================================================
-- Conversao vira FRACAO sobre os dias observados, nas duas RPCs (D-170).
--
-- Dois defeitos medidos no Dev antes desta migration:
--
-- 1. UNIDADE divergente. `get_listing_traffic` devolvia percentual
--    (`* 100`, "10.00") e `get_listing_dashboard_summary` (D-168) devolvia
--    fracao ("0.1000") — a MESMA metrica em duas unidades, com a tela de
--    /anuncios concatenando "%" no numero cru (sem locale: "10.23%" com
--    ponto). A casa ja tinha padrao: `taxa_cancelamento` e fracao com
--    `round(..., 4)` e `formatPercent` recebe FRACAO. As duas passam a
--    seguir isso.
--
-- 2. BASE errada. O numerador somava pedidos da janela inteira sobre um
--    denominador que so existe nos dias em que o job coletou visitas. Em
--    agosto/2026 o Dev tinha 11 dias de coleta para 31 de pedidos: 93
--    anuncios apareciam acima de 100% de conversao, o maior com 2900%.
--    Restringir o numerador aos dias observados zera os 93 (maior passa a
--    ser exatamente 1,0000) — o mesmo principio do subconjunto coberto de
--    D-166: numerador e denominador do MESMO recorte.
--
-- `days_observed` sai junto porque a tela precisa DECLARAR sobre quantos
-- dias a razao foi calculada — media de 4,9 dias em 31 no Dev. Numero sem
-- essa cobertura ao lado seria honesto na formula e enganoso na leitura.
--
-- `orders_count` continua sendo os pedidos da JANELA INTEIRA: e outra
-- pergunta ("quantos pedidos este anuncio teve?"), legitima e exibida em
-- coluna propria.
--
-- DROP + CREATE, nao CREATE OR REPLACE: a lista de OUT parameters mudou, e
-- o Postgres recusa a troca (42P13).
-- ============================================================

drop function public.get_listing_traffic(uuid, date, date);

create function public.get_listing_traffic(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  ml_account_id uuid,
  item_id text,
  visits numeric,
  orders_count bigint,
  days_observed integer,
  conversion_rate numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with visits as (
    select v.ml_account_id, v.item_id,
           sum(v.visits) as visits,
           count(*)::integer as days_observed
    from public.daily_listing_visits v
    where v.organization_id = p_organization_id
      and v.metric_date between p_date_from and p_date_to
    group by v.ml_account_id, v.item_id
  ),
  orders as (
    select m.ml_account_id, m.mlb_id as item_id, sum(m.orders_count) as orders_count
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id
  ),
  orders_observed as (
    -- Pedidos SO dos dias em que houve visita observada — o recorte que o
    -- denominador cobre.
    select v.ml_account_id, v.item_id, sum(coalesce(m.orders_count, 0)) as orders_count
    from public.daily_listing_visits v
    left join public.daily_listing_metrics m
      on m.organization_id = v.organization_id
     and m.ml_account_id = v.ml_account_id
     and m.mlb_id = v.item_id
     and m.metric_date = v.metric_date
    where v.organization_id = p_organization_id
      and v.metric_date between p_date_from and p_date_to
    group by v.ml_account_id, v.item_id
  )
  select
    coalesce(v.ml_account_id, o.ml_account_id) as ml_account_id,
    coalesce(v.item_id, o.item_id) as item_id,
    coalesce(v.visits, 0) as visits,
    coalesce(o.orders_count, 0)::bigint as orders_count,
    coalesce(v.days_observed, 0) as days_observed,
    round(oo.orders_count::numeric / nullif(v.visits, 0), 4) as conversion_rate
  from visits v
  full outer join orders o on o.ml_account_id = v.ml_account_id and o.item_id = v.item_id
  left join orders_observed oo on oo.ml_account_id = v.ml_account_id and oo.item_id = v.item_id
$$;

comment on function public.get_listing_traffic(uuid, date, date) is
  'Visitas e conversao por ANUNCIO (metricas visitas e taxa_conversao do catalogo, D-170). conversion_rate e FRACAO (0,0728 = 7,28%) e usa como numerador os pedidos dos DIAS COM VISITA OBSERVADA — nunca a janela inteira, que inflava a razao acima de 100% (medido: 93 anuncios, ate 2900%). days_observed acompanha para a tela declarar a cobertura. orders_count segue sendo o total da janela, outra pergunta. NULL sem visita, nunca Infinity.';

revoke all on function public.get_listing_traffic(uuid, date, date) from public, anon;
grant execute on function public.get_listing_traffic(uuid, date, date) to authenticated, service_role;

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
  conversion numeric
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
  )
  select m.units, m.revenue, m.orders, v.total_visits, v.days_observed,
         round(oo.orders_observed::numeric / nullif(v.total_visits, 0), 4) as conversion
  from m, v, oo
$$;

comment on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) is
  'Resumo de vendas + trafego de UM anuncio (Dashboard 360º, D-168; conversao corrigida em D-170): soma das linhas do grao listing (equivalencia provada em D-123) + visitas. conversion e FRACAO sobre os pedidos dos DIAS COM VISITA OBSERVADA, com days_observed ao lado para a tela declarar a cobertura; NULL sem visita. security invoker: RLS filtra antes da soma.';

revoke all on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) from public, anon;
grant execute on function public.get_listing_dashboard_summary(uuid, uuid, text, date, date) to authenticated, service_role;
