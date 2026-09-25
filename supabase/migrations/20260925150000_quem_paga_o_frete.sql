-- D-412 — Quem paga o frete, na central.
--
-- D-407 grava, de cada envio, o frete cheio e as quatro partes: o que o
-- vendedor pagou, o desconto do Mercado Livre no frete dele, o que o comprador
-- pagou e o frete do comprador bancado pelo Mercado Livre. Esta função as soma
-- num período -- no total e por logística (Full, coleta, Flex).
--
-- POR ENVIO, NÃO POR PEDIDO. Os pedidos de um pacote dividem o mesmo envio, e
-- `/shipments/{id}/costs` devolve o custo do envio INTEIRO a cada um. Medido
-- em produção (25/09, 30 dias): 99 envios compartilhados por 202 pedidos; em 62
-- deles o custo vinha repetido, R$ 1.576,12 a mais (0,37% do frete do
-- vendedor) se somado pedido a pedido. Aqui cada envio conta uma vez.
--
-- COBERTURA DITA. O detalhe existe desde a captura de D-407 (25/09); o
-- período anterior tem só o frete do vendedor. A função devolve quantos envios
-- do período têm o detalhe, contra os que têm frete capturado, e desde quando o
-- detalhe existe -- a tela não pode fazer um mês parecer medido com um dia.
--
-- AS PARTES, NÃO O CHEIO. Em 4,7% dos envios as partes não fecham com o frete
-- cheio (descontos do comprador que se sobrepõem, D-407). As somas são das
-- partes; o cheio vem ao lado, e os que não fecham são contados.

create or replace function public.get_quem_paga_frete(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_de timestamptz := (p_date_from::timestamp at time zone 'America/Sao_Paulo');
  v_ate timestamptz := ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo');
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido' using errcode = '22023';
  end if;

  return (
  with envios as materialized (
    -- Um por envio: o primeiro pedido dele (pelo id) carrega os custos.
    select distinct on (o.shipping_id)
      o.shipping_id,
      coalesce(o.logistic_type, 'desconhecida') as logistica,
      f.shipping_list_cost as cheio,
      f.seller_shipping_cost as vendedor,
      f.seller_shipping_subsidy as ml_vendedor,
      f.buyer_shipping_cost as comprador,
      f.buyer_shipping_subsidy as ml_comprador
    from public.orders o
    join public.order_financials f on f.order_id = o.id
    where o.date_created >= v_de
      and o.date_created < v_ate
      and o.status in ('paid', 'partially_refunded')
      and o.shipping_id is not null
      and f.seller_shipping_cost is not null
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
    order by o.shipping_id, o.id
  ),
  com_detalhe as materialized (
    select e.*,
           abs(e.cheio - (e.vendedor + e.ml_vendedor + e.comprador + e.ml_comprador)) >= 0.015 as nao_fecha
    from envios e
    where e.cheio is not null
      and e.ml_vendedor is not null
      and e.comprador is not null
      and e.ml_comprador is not null
  ),
  por_logistica as (
    select
      d.logistica,
      count(*) as envios,
      round(sum(d.vendedor + d.ml_vendedor), 2) as frete_do_vendedor,
      round(sum(d.vendedor), 2) as vendedor_pagou,
      round(sum(d.ml_vendedor), 2) as ml_bancou_vendedor,
      round(sum(d.comprador), 2) as comprador_pagou,
      round(sum(d.ml_comprador), 2) as ml_bancou_comprador,
      count(*) filter (where d.comprador = 0) as frete_gratis_comprador
    from com_detalhe d
    group by d.logistica
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', p_date_from, 'ate', p_date_to),
    -- O primeiro dia com o detalhe gravado, no alcance de quem chama.
    'detalhe_desde', (
      select min((o.date_created at time zone 'America/Sao_Paulo')::date)
      from public.order_financials f
      join public.orders o on o.id = f.order_id
      where f.shipping_list_cost is not null
        and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
    ),
    'envios_com_frete', (select count(*) from envios),
    'envios_com_detalhe', (select count(*) from com_detalhe),
    'frete_cheio', (select round(sum(d.cheio), 2) from com_detalhe d),
    -- A parte do vendedor antes do desconto: o que ele pagou mais o que o
    -- Mercado Livre bancou dela.
    'frete_do_vendedor', (select round(sum(d.vendedor + d.ml_vendedor), 2) from com_detalhe d),
    'vendedor_pagou', (select round(sum(d.vendedor), 2) from com_detalhe d),
    'ml_bancou_vendedor', (select round(sum(d.ml_vendedor), 2) from com_detalhe d),
    'comprador_pagou', (select round(sum(d.comprador), 2) from com_detalhe d),
    'ml_bancou_comprador', (select round(sum(d.ml_comprador), 2) from com_detalhe d),
    'frete_gratis_comprador', (select count(*) from com_detalhe d where d.comprador = 0),
    'nao_fecham', (select count(*) from com_detalhe d where d.nao_fecha),
    'por_logistica', (
      select coalesce(jsonb_agg(to_jsonb(l) order by l.envios desc, l.logistica), '[]'::jsonb)
      from por_logistica l
    )
  )
  );
end;
$$;

comment on function public.get_quem_paga_frete(date, date, uuid) is
  'Quem paga o frete num período (D-412): das quatro partes de D-407 -- o vendedor, o desconto do Mercado Livre no frete dele, o comprador e o frete do comprador bancado pelo Mercado Livre --, somadas POR ENVIO (os pedidos de um pacote dividem o envio e cada um traz o custo inteiro), no total e por logística. Devolve a cobertura (envios com detalhe contra envios com frete) e o primeiro dia com detalhe. security invoker: a RLS de orders e order_financials vale.';

revoke all on function public.get_quem_paga_frete(date, date, uuid) from public, anon;
grant execute on function public.get_quem_paga_frete(date, date, uuid) to authenticated, service_role;

-- As três partes no catálogo de métricas (METRICS 5O).
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  ('frete_bancado_ml_vendedor', 'Frete do vendedor bancado pelo Mercado Livre',
   'Σ por envio de senders[].discounts[].promoted_amount (GET /shipments/{id}/costs); participação = ÷ (frete do vendedor + ele)',
   'order_financials.seller_shipping_subsidy (D-407), get_quem_paga_frete', array['organization', 'account'],
   'Envios de pedidos válidos com o detalhe de D-407, um por envio (os pedidos de um pacote dividem o envio).',
   'Envios sem o detalhe (capturados antes de 25/09/2026, 4xx, forma inesperada): fora da soma, e a cobertura é dita.',
   'excluded', 'America/Sao_Paulo', date '2026-09-25'),
  ('frete_pago_comprador', 'Frete pago pelo comprador',
   'Σ por envio de receiver.cost (GET /shipments/{id}/costs)',
   'order_financials.buyer_shipping_cost (D-407), get_quem_paga_frete', array['organization', 'account'],
   'Envios de pedidos válidos com o detalhe de D-407, um por envio.',
   'Envios sem o detalhe: fora da soma, e a cobertura é dita.',
   'excluded', 'America/Sao_Paulo', date '2026-09-25'),
  ('frete_bancado_ml_comprador', 'Frete do comprador bancado pelo Mercado Livre',
   'Σ por envio de receiver.discounts[].promoted_amount (GET /shipments/{id}/costs)',
   'order_financials.buyer_shipping_subsidy (D-407), get_quem_paga_frete', array['organization', 'account'],
   'Envios de pedidos válidos com o detalhe de D-407, um por envio. Frete grátis para o comprador = receiver.cost igual a zero.',
   'Envios sem o detalhe: fora da soma, e a cobertura é dita. Em ~5% dos envios as partes não fecham com o frete cheio (descontos do comprador sobrepostos): soma-se a parte como veio.',
   'excluded', 'America/Sao_Paulo', date '2026-09-25');
