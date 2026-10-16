-- ============================================================
-- D-479 -- o faturamento da Shopee sem o laco aninhado entre CTEs
--
-- O ensaio de volume do Go Live (R7, 40 mil pedidos simulados em 120 dias,
-- como `authenticated`) mediu get_shopee_faturamento_pedidos -- a base de
-- get_shopee_faturamento, _composicao, _diario e _por_sku -- em ~3,5 s nos 30
-- dias e ~34 s nos 90 (o teto de 8 s derruba a tela). 95% do tempo era o join
-- final de `por_pedido` com `componentes`, duas CTEs que o Postgres nao estima:
-- laco aninhado, 59 milhoes de comparacoes em 30 dias, quadratico na janela.
--
-- A correcao le os componentes do proprio pedido, pela chave primaria de
-- `shopee_orders`, so quando o financeiro foi lido -- os mesmos campos e a
-- mesma formula de antes. O resto da funcao e o da 20261015010000, byte a
-- byte. Assinatura, colunas e permissoes nao mudam.
-- ============================================================

create or replace function public.get_shopee_faturamento_pedidos(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  shopee_shop_id uuid,
  environment text,
  loja_lida boolean,
  order_sn text,
  order_status text,
  dia date,
  receita numeric,
  recebido numeric,
  financeiro_lido boolean,
  itens bigint,
  unidades bigint,
  sem_sku boolean,
  sku_unico uuid,
  custo numeric,
  custo_ok boolean,
  custo_atual boolean,
  aliquota numeric,
  imposto numeric,
  coberto boolean,
  comissao numeric,
  taxa_servico numeric,
  taxa_transacao numeric,
  frete_loja numeric,
  frete_devolucao numeric,
  cupom_loja numeric,
  afiliados numeric,
  taxa_por_pedido numeric,
  outros numeric,
  comissao_liquida numeric,
  taxa_servico_liquida numeric,
  cupom_shopee numeric,
  moedas_shopee numeric,
  desconto_shopee numeric,
  ajustes numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  lojas as (
    select s.id, s.environment, s.orders_last_success_at is not null as lida
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  vendas as (
    select v.shopee_shop_id, v.order_sn, v.order_status, v.dia, v.shopee_created_at,
           v.receita_bruta as receita, v.recebido, v.financeiro_lido
    from public.shopee_sales_orders v
    where v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  -- MATERIALIZED: referenciada uma vez, o Postgres a embutia no join com
  -- `vendas` e refazia o custo de TODOS os itens para cada pedido (234
  -- pedidos = 108 mil buscas de custo, ~7 s; D-443). Uma vez so.
  custo_itens as materialized (
    -- A regra de custo de get_faturamento (D-356), item a item: o custo do
    -- SKU na data (historico, senao atual; 0 e desconhecido) e, no KIT, a
    -- soma dos componentes -- so com todos conhecidos.
    select
      i.shopee_shop_id,
      i.order_sn,
      i.sku_id,
      i.quantity,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.custo
        else nullif(coalesce(hs.new_cost, s.purchase_cost), 0)
      end * i.quantity as custo,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.fonte
        when coalesce(hs.new_cost, 0) > 0 then 'historico'
        when coalesce(s.purchase_cost, 0) > 0 then 'atual'
      end as fonte
    from vendas v
    join public.shopee_order_items i
      on i.shopee_shop_id = v.shopee_shop_id and i.order_sn = v.order_sn
    left join public.skus s on s.id = i.sku_id
    left join lateral (
      select x.new_cost
      from public.sku_cost_history x
      where x.sku_id = s.id and x.changed_at <= v.shopee_created_at
      order by x.changed_at desc, x.id desc
      limit 1
    ) hs on true
    left join lateral (
      select
        count(*) as componentes,
        case when count(*) > 0 and bool_and(cu.custo is not null) then sum(cu.custo * c.quantity) end as custo,
        case when bool_and(cu.fonte = 'historico') then 'historico' else 'atual' end as fonte
      from public.sku_components c
      join public.skus cs on cs.id = c.component_sku_id
      left join lateral (
        select x.new_cost
        from public.sku_cost_history x
        where x.sku_id = cs.id and x.changed_at <= v.shopee_created_at
        order by x.changed_at desc, x.id desc
        limit 1
      ) hc on true
      cross join lateral (
        select
          nullif(coalesce(hc.new_cost, cs.purchase_cost), 0) as custo,
          case
            when coalesce(hc.new_cost, 0) > 0 then 'historico'
            when coalesce(cs.purchase_cost, 0) > 0 then 'atual'
          end as fonte
      ) cu
      where c.kit_sku_id = s.id
    ) k on true
  ),
  por_pedido as (
    select
      v.shopee_shop_id,
      v.order_sn,
      v.dia,
      v.order_status,
      v.receita,
      v.recebido,
      v.financeiro_lido,
      count(ci.order_sn) as itens,
      sum(ci.quantity)::bigint as unidades,
      coalesce(bool_or(ci.sku_id is null), false) as sem_sku,
      -- O SKU do pedido quando todos os itens sao do mesmo SKU.
      case when count(ci.order_sn) > 0 and count(distinct ci.sku_id) = 1 and bool_and(ci.sku_id is not null)
           then min(ci.sku_id::text)::uuid end as sku_unico,
      sum(ci.custo) as custo,
      coalesce(bool_and(ci.custo is not null), false) as custo_ok,
      coalesce(bool_or(ci.fonte = 'atual'), false) as custo_atual
    from vendas v
    left join custo_itens ci on ci.shopee_shop_id = v.shopee_shop_id and ci.order_sn = v.order_sn
    group by v.shopee_shop_id, v.order_sn, v.dia, v.order_status, v.receita, v.recebido, v.financeiro_lido
  ),
  aliquotas as (
    select t.valid_from as desde,
           lead(t.valid_from) over (order by t.valid_from) as ate,
           t.rate
    from public.tax_rates t
    where t.organization_id = p_organization_id
  )
  select
    p.shopee_shop_id,
    l.environment,
    l.lida,
    p.order_sn,
    p.order_status,
    p.dia,
    p.receita,
    p.recebido,
    p.financeiro_lido,
    p.itens,
    p.unidades,
    p.sem_sku,
    p.sku_unico,
    p.custo,
    p.custo_ok,
    p.custo_atual,
    a.rate,
    p.receita * a.rate,
    (p.receita is not null and p.financeiro_lido and p.recebido is not null
      and p.itens > 0 and not p.sem_sku and p.custo_ok),
    c.comissao,
    c.taxa_servico,
    c.taxa_transacao,
    c.frete_loja,
    c.frete_devolucao,
    c.cupom_loja,
    c.afiliados,
    c.taxa_por_pedido,
    -- O que a lista nao explica, para fechar receita -> recebido.
    case when p.receita is not null and p.recebido is not null
         then p.receita - p.recebido
              - coalesce(c.comissao, 0) - coalesce(c.taxa_servico, 0) - coalesce(c.taxa_transacao, 0)
              - coalesce(c.frete_loja, 0) - coalesce(c.frete_devolucao, 0) - coalesce(c.cupom_loja, 0)
              - coalesce(c.afiliados, 0) - coalesce(c.taxa_por_pedido, 0) end,
    c.comissao_liquida,
    c.taxa_servico_liquida,
    c.cupom_shopee,
    c.moedas_shopee,
    c.desconto_shopee,
    c.ajustes
  from por_pedido p
  join lojas l on l.id = p.shopee_shop_id
  left join aliquotas a on p.dia >= a.desde and (a.ate is null or p.dia < a.ate)
  -- D-479: os componentes do recebido vem do proprio pedido, pela chave
  -- primaria, so quando o financeiro foi lido. Antes eram duas CTEs (`renda` e
  -- `componentes`) ligadas a `por_pedido` no fim: o Postgres nao estima linhas
  -- de CTE e escolhia laco aninhado -- 8 mil pedidos x 7 mil componentes = 59
  -- milhoes de comparacoes, ~6 s em 30 dias e ~34 s em 90 com 40 mil pedidos.
  left join public.shopee_orders o
    on p.financeiro_lido and o.shopee_shop_id = p.shopee_shop_id and o.order_sn = p.order_sn
  left join lateral (
    -- Os campos do `order_income` (D-427) que a formula oficial usa. As
    -- colunas de `shopee_orders` sao as mesmas do json; o que nao tem coluna
    -- sai do json.
    select
      (o.order_income ->> 'shipping_fee_discount_from_3pl')::numeric as desconto_3pl,
      (o.order_income ->> 'final_return_to_seller_shipping_fee')::numeric as frete_retorno,
      (o.order_income ->> 'seller_coin_cash_back')::numeric as moedas_loja,
      (o.order_income ->> 'coins')::numeric as moedas_shopee
  ) j on true
  left join lateral (
    select
      o.commission_fee as comissao,
      o.service_fee as taxa_servico,
      o.seller_transaction_fee as taxa_transacao,
      case when num_nonnulls(o.actual_shipping_fee, o.buyer_paid_shipping_fee, o.shopee_shipping_rebate, j.desconto_3pl) > 0
           then coalesce(o.actual_shipping_fee, 0) - coalesce(o.buyer_paid_shipping_fee, 0)
                - coalesce(o.shopee_shipping_rebate, 0) - coalesce(j.desconto_3pl, 0) end as frete_loja,
      case when num_nonnulls(o.reverse_shipping_fee, j.frete_retorno) > 0
           then coalesce(o.reverse_shipping_fee, 0) + coalesce(j.frete_retorno, 0) end as frete_devolucao,
      case when num_nonnulls(o.voucher_from_seller, j.moedas_loja) > 0
           then coalesce(o.voucher_from_seller, 0) + coalesce(j.moedas_loja, 0) end as cupom_loja,
      o.order_ams_commission_fee as afiliados,
      o.seller_order_processing_fee as taxa_por_pedido,
      o.net_commission_fee as comissao_liquida,
      o.net_service_fee as taxa_servico_liquida,
      o.voucher_from_shopee as cupom_shopee,
      j.moedas_shopee,
      o.shopee_discount as desconto_shopee,
      o.total_adjustment_amount as ajustes
  ) c on true;
end;
$$;

comment on function public.get_shopee_faturamento_pedidos(uuid, date, date, uuid[]) is
  'D-443: o pedido Shopee no faturamento -- cobertura (D-437), custo (D-356), aliquota do dia (D-395) e os componentes do recebido pela formula oficial do escrow, com outros = receita - recebido - componentes. Todas as lojas do recorte, com ambiente e se ja foi lida; quem soma decide. security invoker. D-479: os componentes vem do pedido pela chave primaria, sem ligar CTEs no fim.';
