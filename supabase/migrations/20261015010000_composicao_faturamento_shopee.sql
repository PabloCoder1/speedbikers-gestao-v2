-- ============================================================
-- D-443 -- a composicao do faturamento da Shopee (contrato C-61, pedido do
-- Agente 2 para a T5b: a cascata "para onde vai o dinheiro", a serie diaria e
-- os produtos no recorte Shopee).
--
-- 1. `get_shopee_faturamento_pedidos`: a definicao UNICA do pedido no
--    faturamento da Shopee -- a cobertura de D-437 (valido, receita
--    conhecida, financeiro lido, SKU e custo em todos os itens), o custo pela
--    regra de D-356, a aliquota do dia (D-395) e os componentes do recebido.
--    `get_shopee_faturamento` (C-58) passa a ler dela; as novas tambem.
-- 2. Os componentes seguem a FORMULA OFICIAL do `escrow_amount`
--    (v2.payment.get_escrow_detail, conferida em 14/10/2026), termo a termo:
--      comissao        = commission_fee
--      taxa_servico    = service_fee
--      taxa_transacao  = seller_transaction_fee
--      frete_loja      = actual_shipping_fee - buyer_paid_shipping_fee
--                        - shopee_shipping_rebate - shipping_fee_discount_from_3pl
--                        (o frete que fica com a loja; negativo = sobrou)
--      frete_devolucao = reverse_shipping_fee + final_return_to_seller_shipping_fee
--      cupom_loja      = voucher_from_seller + seller_coin_cash_back
--      afiliados       = order_ams_commission_fee
--      taxa_por_pedido = seller_order_processing_fee
--    e OUTROS = receita - recebido - (a soma deles): o que a formula tem e a
--    lista nao (taxas regionais, protecoes, repasse de desconto da Shopee,
--    devolucao parcial) e qualquer diferenca entre a receita bruta e a base
--    da formula. Pode ser negativo (credito). `final_shipping_fee` NAO entra:
--    no unico pedido real lido (sandbox, 14/10) ele veio -7,18 com o frete
--    pago pelo comprador igual ao real -- a loja nao pagou nada.
-- 3. Campo ausente no `order_income` e "nao se aplica" para a Shopee (ela so
--    manda o que vale para a loja): no pedido, o componente sem nenhum dos
--    seus campos e NULO; na soma, NULO quando nenhum pedido coberto o tem.
-- 4. Informativos, fora da cascata: comissao e taxa LIQUIDAS (`net_*`, so
--    vendedor local do Brasil, depois do abatimento); cupom, moedas e
--    desconto bancados pela Shopee; os ajustes depois do escrow
--    (`total_adjustment_amount`, que o recebido de D-437 nao inclui).
-- 5. Correcao do C-58 (achado do A2): o TOTAL somava a receita das lojas e
--    dava NULO quando a loja lida nao tinha pedido; a linha da loja (e o C-53)
--    da 0. Agora o TOTAL soma como a linha: receita bruta conhecida, com os
--    pedidos sem receita contados a parte.
--
-- Por SKU, so pedidos de UM SKU: sem rateio inventado do recebido entre os
-- itens (a Shopee nao manda taxa por item). Os de varios SKUs sao contados.
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
  ),
  -- Os campos do `order_income` (D-427) que a formula oficial usa. As colunas
  -- de `shopee_orders` sao as mesmas do json; o que nao tem coluna sai do json.
  renda as (
    select
      o.shopee_shop_id,
      o.order_sn,
      o.commission_fee,
      o.service_fee,
      o.seller_transaction_fee,
      o.actual_shipping_fee,
      o.buyer_paid_shipping_fee,
      o.shopee_shipping_rebate,
      (o.order_income ->> 'shipping_fee_discount_from_3pl')::numeric as desconto_3pl,
      o.reverse_shipping_fee,
      (o.order_income ->> 'final_return_to_seller_shipping_fee')::numeric as frete_retorno,
      o.voucher_from_seller,
      (o.order_income ->> 'seller_coin_cash_back')::numeric as moedas_loja,
      o.order_ams_commission_fee,
      o.seller_order_processing_fee,
      o.net_commission_fee,
      o.net_service_fee,
      o.voucher_from_shopee,
      (o.order_income ->> 'coins')::numeric as moedas_shopee,
      o.shopee_discount,
      o.total_adjustment_amount
    from public.shopee_orders o
    join por_pedido p on p.shopee_shop_id = o.shopee_shop_id and p.order_sn = o.order_sn
    where p.financeiro_lido
  ),
  -- MATERIALIZED pelo mesmo motivo de custo_itens: uma vez, nao por pedido.
  componentes as materialized (
    select
      r.shopee_shop_id,
      r.order_sn,
      r.commission_fee as comissao,
      r.service_fee as taxa_servico,
      r.seller_transaction_fee as taxa_transacao,
      case when num_nonnulls(r.actual_shipping_fee, r.buyer_paid_shipping_fee, r.shopee_shipping_rebate, r.desconto_3pl) > 0
           then coalesce(r.actual_shipping_fee, 0) - coalesce(r.buyer_paid_shipping_fee, 0)
                - coalesce(r.shopee_shipping_rebate, 0) - coalesce(r.desconto_3pl, 0) end as frete_loja,
      case when num_nonnulls(r.reverse_shipping_fee, r.frete_retorno) > 0
           then coalesce(r.reverse_shipping_fee, 0) + coalesce(r.frete_retorno, 0) end as frete_devolucao,
      case when num_nonnulls(r.voucher_from_seller, r.moedas_loja) > 0
           then coalesce(r.voucher_from_seller, 0) + coalesce(r.moedas_loja, 0) end as cupom_loja,
      r.order_ams_commission_fee as afiliados,
      r.seller_order_processing_fee as taxa_por_pedido,
      r.net_commission_fee as comissao_liquida,
      r.net_service_fee as taxa_servico_liquida,
      r.voucher_from_shopee as cupom_shopee,
      r.moedas_shopee,
      r.shopee_discount as desconto_shopee,
      r.total_adjustment_amount as ajustes
    from renda r
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
  left join componentes c on c.shopee_shop_id = p.shopee_shop_id and c.order_sn = p.order_sn;
end;
$$;

comment on function public.get_shopee_faturamento_pedidos(uuid, date, date, uuid[]) is
  'D-443: o pedido Shopee no faturamento -- cobertura (D-437), custo (D-356), aliquota do dia (D-395) e os componentes do recebido pela formula oficial do escrow, com outros = receita - recebido - componentes. Todas as lojas do recorte, com ambiente e se ja foi lida; quem soma decide. security invoker.';

revoke all on function public.get_shopee_faturamento_pedidos(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_faturamento_pedidos(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- C-58, agora sobre a definicao unica; o TOTAL soma a receita como a linha
-- da loja (o achado do A2). O resto e o mesmo numero de antes.
-- ------------------------------------------------------------
create or replace function public.get_shopee_faturamento(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  account_id uuid,
  account_name text,
  environment text,
  pedidos bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  recebido_coberto numeric,
  custo_produtos numeric,
  resultado_venda numeric,
  margem_venda numeric,
  pedidos_definitivos bigint,
  resultado_definitivo numeric,
  pedidos_provisorios bigint,
  resultado_provisorio numeric,
  pedidos_sem_financeiro bigint,
  pedidos_sem_sku bigint,
  pedidos_sem_custo bigint,
  pedidos_custo_atual bigint,
  pedidos_sem_aliquota bigint,
  imposto_coberto numeric,
  resultado_apos_imposto numeric,
  margem_apos_imposto numeric,
  ultima_atualizacao timestamptz
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
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  classificado as (
    select k.* from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
  ),
  por_loja as (
    select
      l.id,
      l.nome,
      l.environment,
      l.orders_last_success_at as atualizado,
      l.orders_last_success_at is not null as lida,
      count(k.order_sn) as pedidos,
      sum(k.receita) as receita,
      count(k.order_sn) filter (where k.receita is null) as sem_receita,
      count(k.order_sn) filter (where k.coberto) as cobertos,
      sum(k.receita) filter (where k.coberto) as receita_coberta,
      sum(k.recebido) filter (where k.coberto) as recebido_coberto,
      sum(k.custo) filter (where k.coberto) as custo,
      sum(k.recebido - k.custo) filter (where k.coberto) as resultado,
      count(k.order_sn) filter (where k.coberto and k.order_status = 'COMPLETED') as definitivos,
      sum(k.recebido - k.custo) filter (where k.coberto and k.order_status = 'COMPLETED') as resultado_definitivo,
      count(k.order_sn) filter (where k.coberto and k.order_status <> 'COMPLETED') as provisorios,
      sum(k.recebido - k.custo) filter (where k.coberto and k.order_status <> 'COMPLETED') as resultado_provisorio,
      count(k.order_sn) filter (where k.receita is not null and not k.financeiro_lido) as sem_financeiro,
      count(k.order_sn) filter (where k.sem_sku) as sem_sku,
      count(k.order_sn) filter (where not k.sem_sku and not k.custo_ok) as sem_custo,
      count(k.order_sn) filter (where k.coberto and k.custo_atual) as custo_atual,
      count(k.order_sn) filter (where k.coberto and k.aliquota is null) as sem_aliquota,
      sum(k.imposto) filter (where k.coberto) as imposto
    from lojas l
    left join classificado k on k.shopee_shop_id = l.id
    group by l.id, l.nome, l.environment, l.orders_last_success_at
  ),
  -- O que entra no TOTAL: loja live ja lida.
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    sum(s.pedidos)::bigint,
    -- A receita bruta conhecida, como na linha da loja: loja lida sem pedido e 0.
    round(sum(coalesce(s.receita, 0)), 2),
    sum(s.sem_receita)::bigint,
    sum(s.cobertos)::bigint,
    round(sum(s.receita_coberta), 2),
    round(sum(s.recebido_coberto), 2),
    round(sum(s.custo), 2),
    round(sum(s.resultado), 2),
    round(sum(s.resultado) / nullif(sum(s.receita_coberta), 0), 4),
    sum(s.definitivos)::bigint,
    round(sum(s.resultado_definitivo), 2),
    sum(s.provisorios)::bigint,
    round(sum(s.resultado_provisorio), 2),
    sum(s.sem_financeiro)::bigint,
    sum(s.sem_sku)::bigint,
    sum(s.sem_custo)::bigint,
    sum(s.custo_atual)::bigint,
    sum(s.sem_aliquota)::bigint,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0 then round(sum(s.imposto), 2) end,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0 then round(sum(s.resultado) - sum(s.imposto), 2) end,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0
         then round((sum(s.resultado) - sum(s.imposto)) / nullif(sum(s.receita_coberta), 0), 4) end,
    case when bool_or(s.atualizado is null) then null else min(s.atualizado) end
  from somaveis s
  having count(*) > 0

  union all

  -- Por loja. Loja nunca lida: tudo NULO.
  select
    'CONTA', pl.id, pl.nome, pl.environment,
    case when pl.lida then pl.pedidos end::bigint,
    case when pl.lida then round(coalesce(pl.receita, 0), 2) end,
    case when pl.lida then pl.sem_receita end::bigint,
    case when pl.lida then pl.cobertos end::bigint,
    case when pl.lida then round(pl.receita_coberta, 2) end,
    case when pl.lida then round(pl.recebido_coberto, 2) end,
    case when pl.lida then round(pl.custo, 2) end,
    case when pl.lida then round(pl.resultado, 2) end,
    case when pl.lida then round(pl.resultado / nullif(pl.receita_coberta, 0), 4) end,
    case when pl.lida then pl.definitivos end::bigint,
    case when pl.lida then round(pl.resultado_definitivo, 2) end,
    case when pl.lida then pl.provisorios end::bigint,
    case when pl.lida then round(pl.resultado_provisorio, 2) end,
    case when pl.lida then pl.sem_financeiro end::bigint,
    case when pl.lida then pl.sem_sku end::bigint,
    case when pl.lida then pl.sem_custo end::bigint,
    case when pl.lida then pl.custo_atual end::bigint,
    case when pl.lida then pl.sem_aliquota end::bigint,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0 then round(pl.imposto, 2) end,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0 then round(pl.resultado - pl.imposto, 2) end,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0
         then round((pl.resultado - pl.imposto) / nullif(pl.receita_coberta, 0), 4) end,
    pl.atualizado
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_faturamento(uuid, date, date, uuid[]) is
  'Faturamento Shopee (D-437, D-443): por loja e o TOTAL (so lojas live ja lidas), resultado = recebido (escrow) - custo e margem sobre a receita, nos pedidos cobertos; definitivo (COMPLETED) e provisorio separados; imposto pela aliquota do dia (D-395) so com todas as aliquotas; o que nao cobre, contado por motivo. Le get_shopee_faturamento_pedidos. Nao soma com o resultado do ML (5F).';

-- ------------------------------------------------------------
-- A cascata: receita coberta -> componentes -> outros -> recebido coberto.
-- ------------------------------------------------------------
create or replace function public.get_shopee_faturamento_composicao(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  account_id uuid,
  account_name text,
  environment text,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  comissao numeric,
  taxa_servico numeric,
  taxa_transacao numeric,
  frete_loja numeric,
  frete_devolucao numeric,
  cupom_loja numeric,
  afiliados numeric,
  taxa_por_pedido numeric,
  outros numeric,
  recebido_coberto numeric,
  comissao_liquida numeric,
  taxa_servico_liquida numeric,
  cupom_shopee numeric,
  moedas_shopee numeric,
  desconto_shopee numeric,
  pedidos_com_ajuste bigint,
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
  return query
  with
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment,
           s.orders_last_success_at is not null as lida
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  cobertos as (
    select k.* from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
    where k.coberto
  ),
  por_loja as (
    select
      l.id, l.nome, l.environment, l.lida,
      count(k.order_sn) as pedidos,
      sum(k.receita) as receita,
      sum(k.comissao) as comissao,
      sum(k.taxa_servico) as taxa_servico,
      sum(k.taxa_transacao) as taxa_transacao,
      sum(k.frete_loja) as frete_loja,
      sum(k.frete_devolucao) as frete_devolucao,
      sum(k.cupom_loja) as cupom_loja,
      sum(k.afiliados) as afiliados,
      sum(k.taxa_por_pedido) as taxa_por_pedido,
      sum(k.outros) as outros,
      sum(k.recebido) as recebido,
      sum(k.comissao_liquida) as comissao_liquida,
      sum(k.taxa_servico_liquida) as taxa_servico_liquida,
      sum(k.cupom_shopee) as cupom_shopee,
      sum(k.moedas_shopee) as moedas_shopee,
      sum(k.desconto_shopee) as desconto_shopee,
      count(k.order_sn) filter (where k.ajustes <> 0) as com_ajuste,
      sum(k.ajustes) as ajustes
    from lojas l
    left join cobertos k on k.shopee_shop_id = l.id
    group by l.id, l.nome, l.environment, l.lida
  ),
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    sum(s.pedidos)::bigint,
    round(sum(s.receita), 2),
    round(sum(s.comissao), 2),
    round(sum(s.taxa_servico), 2),
    round(sum(s.taxa_transacao), 2),
    round(sum(s.frete_loja), 2),
    round(sum(s.frete_devolucao), 2),
    round(sum(s.cupom_loja), 2),
    round(sum(s.afiliados), 2),
    round(sum(s.taxa_por_pedido), 2),
    round(sum(s.outros), 2),
    round(sum(s.recebido), 2),
    round(sum(s.comissao_liquida), 2),
    round(sum(s.taxa_servico_liquida), 2),
    round(sum(s.cupom_shopee), 2),
    round(sum(s.moedas_shopee), 2),
    round(sum(s.desconto_shopee), 2),
    sum(s.com_ajuste)::bigint,
    round(sum(s.ajustes), 2)
  from somaveis s
  having count(*) > 0

  union all

  select
    'CONTA', pl.id, pl.nome, pl.environment,
    case when pl.lida then pl.pedidos end::bigint,
    case when pl.lida then round(pl.receita, 2) end,
    case when pl.lida then round(pl.comissao, 2) end,
    case when pl.lida then round(pl.taxa_servico, 2) end,
    case when pl.lida then round(pl.taxa_transacao, 2) end,
    case when pl.lida then round(pl.frete_loja, 2) end,
    case when pl.lida then round(pl.frete_devolucao, 2) end,
    case when pl.lida then round(pl.cupom_loja, 2) end,
    case when pl.lida then round(pl.afiliados, 2) end,
    case when pl.lida then round(pl.taxa_por_pedido, 2) end,
    case when pl.lida then round(pl.outros, 2) end,
    case when pl.lida then round(pl.recebido, 2) end,
    case when pl.lida then round(pl.comissao_liquida, 2) end,
    case when pl.lida then round(pl.taxa_servico_liquida, 2) end,
    case when pl.lida then round(pl.cupom_shopee, 2) end,
    case when pl.lida then round(pl.moedas_shopee, 2) end,
    case when pl.lida then round(pl.desconto_shopee, 2) end,
    case when pl.lida then pl.com_ajuste end::bigint,
    case when pl.lida then round(pl.ajustes, 2) end
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_faturamento_composicao(uuid, date, date, uuid[]) is
  'D-443 (C-61): para onde vai o dinheiro da Shopee nos pedidos cobertos (os mesmos de get_shopee_faturamento) -- receita coberta, os componentes da formula oficial do escrow, outros (pode ser negativo) e o recebido coberto; receita - componentes - outros = recebido. Informativos: comissao e taxa liquidas (BR), o bancado pela Shopee e os ajustes depois do escrow. TOTAL so lojas live lidas; loja nunca lida, NULO. security invoker.';

revoke all on function public.get_shopee_faturamento_composicao(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_faturamento_composicao(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- A serie diaria (dia de Sao Paulo): o "Receita e margem por dia" do ML.
-- So lojas live ja lidas; dia sem pedido nao aparece.
-- ------------------------------------------------------------
create or replace function public.get_shopee_faturamento_diario(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  dia date,
  pedidos bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  recebido_coberto numeric,
  custo_produtos numeric,
  resultado_venda numeric,
  margem_venda numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  return query
  select
    k.dia,
    count(*)::bigint,
    -- Dia so com pedidos de receita desconhecida: NULO (lacuna, nao zero).
    round(sum(k.receita), 2),
    count(*) filter (where k.receita is null)::bigint,
    count(*) filter (where k.coberto)::bigint,
    round(sum(k.receita) filter (where k.coberto), 2),
    round(sum(k.recebido) filter (where k.coberto), 2),
    round(sum(k.custo) filter (where k.coberto), 2),
    round(sum(k.recebido - k.custo) filter (where k.coberto), 2),
    round(sum(k.recebido - k.custo) filter (where k.coberto) / nullif(sum(k.receita) filter (where k.coberto), 0), 4)
  from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
  where k.environment = 'live' and k.loja_lida
  group by k.dia
  order by k.dia;
end;
$$;

comment on function public.get_shopee_faturamento_diario(uuid, date, date, uuid[]) is
  'D-443 (C-61): faturamento da Shopee por dia de Sao Paulo, so lojas live lidas -- receita bruta (nula no dia so de receita desconhecida), cobertura, recebido, custo, resultado e margem dos cobertos. A soma dos dias fecha com o TOTAL de get_shopee_faturamento. security invoker.';

revoke all on function public.get_shopee_faturamento_diario(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_faturamento_diario(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- Por produto: so pedidos de UM SKU (sem rateio do recebido entre itens).
-- ------------------------------------------------------------
create or replace function public.get_shopee_faturamento_por_sku(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null,
  -- 'receita' (maior receita bruta) | 'margem' (menor margem, so com cobertos)
  p_ordem text default 'receita',
  p_limit integer default 30
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  unidades bigint,
  pedidos bigint,
  receita_bruta numeric,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  recebido_coberto numeric,
  custo_produtos numeric,
  resultado_venda numeric,
  margem_venda numeric,
  custo_atual boolean,
  -- SKUs da lista inteira, antes do limite.
  total_count bigint,
  pedidos_varios_skus bigint,
  receita_varios_skus numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  if coalesce(p_ordem, 'receita') not in ('receita', 'margem') then
    raise exception 'ordem invalida: % (use receita ou margem)', p_ordem;
  end if;

  return query
  with
  vendidos as (
    select k.* from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
    where k.environment = 'live' and k.loja_lida
  ),
  varios as (
    select count(*) as n, sum(p.receita) as receita
    from vendidos p
    where p.sku_unico is null and p.itens > 0 and not p.sem_sku
  ),
  por_sku as (
    select
      p.sku_unico as sku_id,
      sum(p.unidades)::bigint as unidades,
      count(*)::bigint as pedidos,
      sum(p.receita) as receita,
      count(*) filter (where p.coberto)::bigint as cobertos,
      sum(p.receita) filter (where p.coberto) as receita_coberta,
      sum(p.recebido) filter (where p.coberto) as recebido,
      sum(p.custo) filter (where p.coberto) as custo,
      sum(p.recebido - p.custo) filter (where p.coberto) as resultado,
      coalesce(bool_or(p.custo_atual) filter (where p.coberto), false) as custo_atual
    from vendidos p
    where p.sku_unico is not null
    group by p.sku_unico
  )
  select
    b.sku_id, s.sku, s.title,
    b.unidades, b.pedidos, round(b.receita, 2),
    b.cobertos, round(b.receita_coberta, 2), round(b.recebido, 2), round(b.custo, 2), round(b.resultado, 2),
    round(b.resultado / nullif(b.receita_coberta, 0), 4),
    b.custo_atual,
    count(*) over (),
    (select v.n from varios v),
    round((select v.receita from varios v), 2)
  from por_sku b
  join public.skus s on s.id = b.sku_id
  where coalesce(p_ordem, 'receita') = 'receita' or b.cobertos > 0
  order by
    case when coalesce(p_ordem, 'receita') = 'receita' then b.receita end desc nulls last,
    case when p_ordem = 'margem' then b.resultado / nullif(b.receita_coberta, 0) end asc nulls last,
    b.receita_coberta desc nulls last,
    b.sku_id
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

comment on function public.get_shopee_faturamento_por_sku(uuid, date, date, uuid[], text, integer) is
  'D-443 (C-61): faturamento da Shopee por SKU, so com pedidos de UM SKU (a Shopee nao manda taxa por item; nada de rateio inventado) -- os de varios SKUs vem contados em pedidos_varios_skus. Ordem por maior receita ou menor margem (so com cobertos); ate 100. So lojas live lidas. security invoker.';

revoke all on function public.get_shopee_faturamento_por_sku(uuid, date, date, uuid[], text, integer) from public, anon;
grant execute on function public.get_shopee_faturamento_por_sku(uuid, date, date, uuid[], text, integer) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (5U): a composicao e os novos graos.
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_composicao_recebido', 'Composicao do recebido da Shopee',
   'receita coberta - (comissao + taxa de servico + taxa de transacao + frete da loja + frete de devolucao + cupom da loja + afiliados + taxa por pedido) - outros = recebido coberto',
   'get_shopee_faturamento_composicao (shopee_orders e order_income, termos da formula oficial do escrow_amount)', array['account', 'organization'],
   'Os pedidos cobertos de shopee_resultado_venda. Frete da loja = frete real - pago pelo comprador - subsidio da Shopee - desconto do 3PL (negativo = sobrou). Outros = o que a formula tem e a lista nao (taxas regionais, protecoes, repasse de desconto da Shopee, devolucao parcial); pode ser negativo.',
   'Componente sem nenhum pedido que o informe: NULO, nao 0. final_shipping_fee nao entra (no sandbox veio negativo com frete zerado). Comissao e taxa liquidas (BR), o bancado pela Shopee e os ajustes depois do escrow sao informativos, fora da cascata. Conferido na documentacao e num pedido de sandbox sem taxas: fechar com loja real e verificacao do Go Live.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14');

update public.metric_definitions
   set granularities = array['sku', 'account', 'organization'],
       definition_updated_on = date '2026-10-14'
 where id in ('shopee_custo_produtos', 'shopee_resultado_venda', 'shopee_margem_venda');
