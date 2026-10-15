-- ============================================================
-- D-469 — get_sales_expanded_summary: os pedidos do período pelo índice da
-- organização e os itens só desses pedidos
--
-- A `/vendas` chama a função duas vezes por carga (período atual e anterior).
-- Medido no Dev, como `authenticated` (pedido do A3: a `/vendas` virou a tela
-- lenta de produção, LCP até 5,9 s): 3.840 ms na primeira chamada fria, ~150
-- ms quente, ~16,5 mil páginas DISTINTAS por chamada (~130 MB) -- as duas
-- mais caras da tela, de longe.
--
-- Por quê:
-- 1. `pedidos` filtrava `orders` só pela data, sem a organização (quem
--    restringe é a RLS). O índice de data é `(organization_id, date_created)`:
--    sem a organização, ele era percorrido inteiro.
-- 2. A tarifa (`sale_fee * quantity`) juntava os pedidos com a `order_items`
--    INTEIRA (11,9 mil páginas no Dev), lida de ponta a ponta.
-- 3. `language sql` com `SET`: o plano genérico (D-305) multiplicava os
--    acessos -- 146 mil na função contra 43 mil no corpo com os valores.
--
-- A correção, sem mudar o contrato (colunas, recortes, NULO sob marca):
-- 1. As organizações vêm das contas que quem chama enxerga (`ml_accounts`,
--    com a RLS dela) e entram no filtro de `orders`: o índice resolve a
--    janela. O resultado é o mesmo -- a RLS de `orders` já limitava às contas
--    acessíveis, que são dessas organizações; e quem passa por cima da RLS
--    continua vendo todas.
-- 2. Os itens só na faixa de ids dos pedidos da janela (`order_id between
--    min e max`, pelo índice `(order_id, position)`), calculada na MESMA
--    consulta. É uma condição a mais, nunca a menos: todo pedido da janela
--    está entre o seu menor e o seu maior id. O id do pedido do ML cresce com
--    a data (correlação 0,999 no Dev), então a faixa traz só os itens do
--    período.
-- 3. `plpgsql` + `force_custom_plan` (D-305).
--
-- Mesmo resultado em 8 recortes (30 dias, o anterior, 7 dias, 1 dia, uma
-- conta, uma marca, sem marca, período sem pedidos); 30 dias: 151 -> 108 ms,
-- 146 mil -> 59 mil acessos, ~16,5 mil -> ~7 mil páginas distintas.
-- ============================================================

create or replace function public.get_sales_expanded_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  taxas_ml numeric,
  pedidos_cancelados bigint,
  taxa_cancelamento numeric,
  valor_cancelado numeric,
  skus_distintos_vendidos bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
#variable_conflict use_column
declare
  v_de timestamptz := (p_date_from::timestamp at time zone 'America/Sao_Paulo');
  v_ate timestamptz := ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  -- As organizações das contas que quem chama enxerga: o filtro que deixa o
  -- índice (organization_id, date_created) servir. A RLS de `orders` já
  -- implicava isso.
  v_orgs uuid[] := array(select distinct a.organization_id from public.ml_accounts a);
begin
  return query
  with recorte as (select (p_supplier_brand is null and not p_sem_marca) as sem_recorte),
  pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.status, o.total_amount
    from public.orders o
    where o.organization_id = any (v_orgs)
      and o.date_created >= v_de
      and o.date_created < v_ate
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  -- A faixa de ids dos pedidos da janela, na mesma consulta. Um passo
  -- separado de min/max em `orders` percorre a chave desde o menor id até
  -- achar a janela -- medido, ficava pior que o original.
  faixa as (select min(p.id) as de, max(p.id) as ate from pedidos p),
  fees as (
    -- D-356: a tarifa e por unidade.
    select coalesce(round(sum(oi.sale_fee * oi.quantity), 2), 0) as taxas_ml
    from pedidos p
    join public.order_items oi
      on oi.order_id = p.id
     and oi.organization_id = p.organization_id
     and oi.ml_account_id = p.ml_account_id
    where oi.order_id between (select f.de from faixa f) and (select f.ate from faixa f)
      and p.status in ('paid', 'partially_refunded')
      and ((p_supplier_brand is null and not p_sem_marca)
           or (case when p_sem_marca
                 then oi.sku_id is null
                      or not exists (select 1 from public.skus s
                                     where s.id = oi.sku_id and s.supplier_brand is not null)
                 else exists (select 1 from public.skus s
                              where s.id = oi.sku_id and s.supplier_brand = p_supplier_brand)
               end))
  ),
  counts as (
    select
      count(*) filter (where p.status in ('cancelled', 'pending_cancel')) as pedidos_cancelados,
      count(*) filter (where p.status in ('paid', 'partially_refunded')) as pedidos_validos,
      coalesce(round(sum(p.total_amount) filter (where p.status in ('cancelled', 'pending_cancel')), 2), 0) as valor_cancelado
    from pedidos p
  ),
  skus as (
    select count(distinct m.sku_id) as skus_distintos_vendidos
    from public.daily_sku_metrics m
    where m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
      and m.units_sold > 0
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and ((p_supplier_brand is null and not p_sem_marca)
           or (case when p_sem_marca
                 then not exists (select 1 from public.skus s
                                  where s.id = m.sku_id and s.supplier_brand is not null)
                 else exists (select 1 from public.skus s
                              where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
               end))
  )
  select
    fees.taxas_ml,
    case when r.sem_recorte then counts.pedidos_cancelados::bigint end,
    case when r.sem_recorte
         then round(counts.pedidos_cancelados::numeric / nullif(counts.pedidos_cancelados + counts.pedidos_validos, 0), 4) end,
    case when r.sem_recorte then counts.valor_cancelado end,
    skus.skus_distintos_vendidos::bigint
  from fees, counts, skus, recorte r;
end;
$fn$;

comment on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) is
  'Numeros expandidos de vendas (D-165; marca desde D-237; uma passada por orders desde D-306; comissao por unidade desde D-356). taxas_ml e skus_distintos_vendidos aceitam recorte de marca -- o primeiro sai de order_items.sale_fee * quantity, o segundo e contagem distinta no grao SKU. O trio de cancelamento volta NULL sob recorte: sao contagem distinta e soma de orders.total_amount, do pedido inteiro, e nao ha cota de marca. Os pedidos da janela pelo indice da organizacao e os itens so na faixa de ids deles, em plpgsql com plano custom (D-469). security invoker.';
