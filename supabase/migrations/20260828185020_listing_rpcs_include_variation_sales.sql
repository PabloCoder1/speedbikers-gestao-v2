-- `get_listing_sales` e `get_listing_traffic` paravam de contar venda de
-- anúncio COM variação (D-123).
--
-- O filtro `m.variation_id is null` não era uma regra de negócio: era o
-- espelho de um limite de escopo que deixou de existir. Enquanto `listings`
-- só continha itens sem variação (enumeração por `sku_listing_links`), somar
-- variações traria linhas sem par na tela. Desde D-121 `listings` é o
-- catálogo REAL — itens com variação estão lá — e o filtro passou a ESCONDER
-- receita real.
--
-- Medido em 2026-08-28, últimos 30 dias: R$ 469.593,20 (15,4% da receita) em
-- 460 anúncios ficavam invisíveis em `/anuncios`.
--
-- SEM risco de dupla contagem, medido e não presumido: `daily_listing_metrics`
-- tem grão (ml_account_id, mlb_id, variation_id, metric_date) e cada item de
-- pedido contribui para exatamente UMA linha. Verificado que **zero** itens
-- têm os dois grãos (com e sem variação) no mesmo dia. Prova final: depois da
-- mudança, a soma do RPC bate com `daily_account_metrics` com diferença de
-- exatamente R$ 0,00 — antes faltavam R$ 469.593,20.
--
-- Nota honesta sobre conversão: itens com variação passam a ter PEDIDOS, mas
-- continuam sem VISITAS — a varredura de visitas ainda enumera
-- `sku_listing_links` com `variation_id is null`. Para esses, `conversion_rate`
-- continua `null` (nunca zero, nunca inventada), que é a resposta correta
-- enquanto o denominador não existir. Medido: 1.060 anúncios vendem sem visita
-- registrada. Trocar a enumeração de visitas é fatia própria — muda a carga na
-- API do Mercado Livre (1 item por chamada).

create or replace function public.get_listing_sales(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  ml_account_id uuid,
  mlb_id text,
  units_sold bigint,
  gross_revenue numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.ml_account_id,
    m.mlb_id,
    sum(m.units_sold)::bigint as units_sold,
    sum(m.gross_revenue) as gross_revenue
  from public.daily_listing_metrics m
  where m.organization_id = p_organization_id
    and m.metric_date between p_date_from and p_date_to
  group by m.ml_account_id, m.mlb_id
$$;

comment on function public.get_listing_sales(uuid, date, date) is
  'Venda somada por ANUNCIO (ml_account_id + mlb_id), somando todas as variacoes (D-123). Soma em SQL, nunca em JS.';

create or replace function public.get_listing_traffic(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  ml_account_id uuid,
  item_id text,
  visits numeric,
  orders_count bigint,
  conversion_rate numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with visits as (
    select v.ml_account_id, v.item_id, sum(v.visits) as visits
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
  )
  select
    coalesce(v.ml_account_id, o.ml_account_id) as ml_account_id,
    coalesce(v.item_id, o.item_id) as item_id,
    coalesce(v.visits, 0) as visits,
    coalesce(o.orders_count, 0)::bigint as orders_count,
    case
      when coalesce(v.visits, 0) = 0 then null
      else round(coalesce(o.orders_count, 0)::numeric / v.visits * 100, 2)
    end as conversion_rate
  from visits v
  full outer join orders o on o.ml_account_id = v.ml_account_id and o.item_id = v.item_id
$$;

comment on function public.get_listing_traffic(uuid, date, date) is
  'Visitas e conversao por ANUNCIO. Pedidos somam todas as variacoes (D-123); visitas ainda so existem para itens sem variacao, entao conversion_rate segue null quando nao ha denominador.';
