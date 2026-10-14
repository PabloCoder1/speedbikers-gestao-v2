-- ============================================================
-- D-436 -- vendas por marketplace e o consolidado no SQL (etapa E4 da
-- frente multicanal, contrato C-53; fatia 6b, a parte de vendas).
--
-- O que SOMA entre os canais (docs/MULTICHANNEL_CONTRACTS.md secao 5):
--   - COMPRAS: o pack do ML (`purchases_count`, a unidade de compra do
--     cliente) e o pedido da Shopee (um pedido = um carrinho). O "pedido" do
--     ML e uma linha de item: NAO soma com o da Shopee e fica so na linha do
--     ML (`pedidos_ml`);
--   - UNIDADES;
--   - RECEITA BRUTA: produtos com o desconto da loja, sem frete, nos dois
--     (5.2 e 5S). Pedido Shopee de receita desconhecida (bundle sem
--     financeiro) fica fora da soma e contado a parte (`pedidos_sem_receita`);
--   - TICKET MEDIO: recalculado sobre a soma (receita / compras de receita
--     conhecida), nunca media de medias.
-- O que NAO soma: o RECEBIDO -- o do ML (5F) e o da Shopee (escrow) tem
-- componentes diferentes. Ele aparece so na linha da Shopee.
--
-- AS LINHAS: TOTAL (o consolidado), uma por MARKETPLACE e, por conta/loja,
-- CONTA. Loja de SANDBOX aparece so em CONTA, com o ambiente, e nunca entra
-- em MARKETPLACE nem em TOTAL. Sem loja live no escopo, a Shopee nao tem
-- linha de MARKETPLACE -- nunca um zero que parece venda nenhuma.
--
-- AS DEFINICOES NAO MUDAM: o ML le `daily_account_metrics`, exatamente o que
-- `get_sales_summary` le (a soma das linhas ML e igual a dela, provado no
-- teste); a Shopee le `shopee_sales_orders` (D-430), com o intervalo tambem
-- em timestamptz para o indice `(organization_id, shopee_created_at)` valer
-- (o `dia` calculado nao usa indice -- R7). Nenhuma RPC do ML muda.
--
-- `p_marketplaces` nulo = so ML (o padrao de hoje das telas). `p_account_ids`
-- sao ids de `marketplace_accounts` (D-435): conta ML ou loja Shopee.
-- security invoker: a permissao por conta (D-175) e por loja (D-433) vale.
-- Sem filtro de marca: no ML a marca e do item e a receita e da linha; no
-- pedido Shopee de varios itens a receita e do pedido -- a semantica nao
-- casa, e fica para quando houver o grao de SKU da Shopee (E6).
-- ============================================================

create or replace function public.get_marketplace_sales_summary(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  marketplace text,
  account_id uuid,
  account_name text,
  environment text,
  compras bigint,
  unidades bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  ticket_medio numeric,
  pedidos_ml bigint,
  recebido numeric,
  pedidos_sem_recebido bigint,
  ultima_atualizacao timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  return query
  with
  contas_ml as (
    -- Toda conta ML alcancada do escopo, com venda ou sem (0 e venda nenhuma,
    -- como em get_sales_summary; o frescor diz se o 0 e de confianca).
    select a.id, a.label
    from public.ml_accounts a
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
  ),
  por_conta_ml as (
    select
      c.id,
      c.label,
      coalesce(sum(m.purchases_count), 0)::bigint as compras,
      coalesce(sum(m.units_sold), 0)::bigint as unidades,
      coalesce(sum(m.gross_revenue), 0) as receita,
      coalesce(sum(m.orders_count), 0)::bigint as pedidos,
      (select r.last_refresh_at from public.metric_refresh_state r where r.ml_account_id = c.id) as atualizado
    from contas_ml c
    left join public.daily_account_metrics m
      on m.ml_account_id = c.id
     and m.metric_date between p_date_from and p_date_to
    group by c.id, c.label
  ),
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at
    from public.shopee_shops s
    where 'SHOPEE' = any (v_marketplaces)
      and s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  vendas_shopee as (
    select
      v.shopee_shop_id,
      count(*) as compras,
      coalesce(sum(v.unidades), 0) as unidades,
      sum(v.receita_bruta) as receita,
      count(*) filter (where v.receita_bruta is null) as sem_receita,
      sum(v.recebido) filter (where v.financeiro_lido) as recebido,
      count(*) filter (where not v.financeiro_lido) as sem_recebido
    from public.shopee_sales_orders v
    where v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by v.shopee_shop_id
  ),
  por_loja as (
    -- Loja cujos pedidos nunca foram lidos: NULO, nunca zero.
    select
      l.id,
      l.nome,
      l.environment,
      case when l.orders_last_success_at is null then null else coalesce(vs.compras, 0) end::bigint as compras,
      case when l.orders_last_success_at is null then null else coalesce(vs.unidades, 0) end::bigint as unidades,
      case when l.orders_last_success_at is null then null else coalesce(vs.receita, 0) end as receita,
      case when l.orders_last_success_at is null then null else coalesce(vs.sem_receita, 0) end::bigint as sem_receita,
      case when l.orders_last_success_at is null then null else coalesce(vs.recebido, 0) end as recebido,
      case when l.orders_last_success_at is null then null else coalesce(vs.sem_recebido, 0) end::bigint as sem_recebido,
      l.orders_last_success_at as atualizado
    from lojas l
    left join vendas_shopee vs on vs.shopee_shop_id = l.id
  ),
  linhas_conta as (
    select 'ML'::text as mk, c.id, c.label as nome, 'live'::text as amb,
           c.compras, c.unidades, c.receita, 0::bigint as sem_receita, c.pedidos,
           null::numeric as recebido, null::bigint as sem_recebido, c.atualizado
    from por_conta_ml c
    union all
    select 'SHOPEE', l.id, l.nome, l.environment,
           l.compras, l.unidades, l.receita, l.sem_receita, null::bigint,
           l.recebido, l.sem_recebido, l.atualizado
    from por_loja l
  ),
  -- So o que e operacao: conta ML e loja live JA LIDA entram nas somas.
  somaveis as (
    select l.* from linhas_conta l where l.amb = 'live' and l.compras is not null
  ),
  por_marketplace as (
    select
      s.mk,
      sum(s.compras)::bigint as compras,
      sum(s.unidades)::bigint as unidades,
      sum(s.receita) as receita,
      sum(s.sem_receita)::bigint as sem_receita,
      case when s.mk = 'ML' then sum(s.pedidos)::bigint end as pedidos,
      case when s.mk = 'SHOPEE' then sum(s.recebido) end as recebido,
      case when s.mk = 'SHOPEE' then sum(s.sem_recebido)::bigint end as sem_recebido,
      -- O elo mais fraco: a conta/loja menos atualizada do grupo.
      case when bool_or(s.atualizado is null) then null else min(s.atualizado) end as atualizado
    from somaveis s
    group by s.mk
  )
  select
    'TOTAL'::text, null::text, null::uuid, null::text, null::text,
    sum(p.compras)::bigint,
    sum(p.unidades)::bigint,
    round(sum(p.receita), 2),
    sum(p.sem_receita)::bigint,
    round(sum(p.receita) / nullif(sum(p.compras) - sum(p.sem_receita), 0), 2),
    null::bigint,
    null::numeric,
    null::bigint,
    case when bool_or(p.atualizado is null) then null else min(p.atualizado) end
  from por_marketplace p
  having count(*) > 0

  union all

  select
    'MARKETPLACE', p.mk, null, null, null,
    p.compras, p.unidades, round(p.receita, 2), p.sem_receita,
    round(p.receita / nullif(p.compras - p.sem_receita, 0), 2),
    p.pedidos, round(p.recebido, 2), p.sem_recebido, p.atualizado
  from por_marketplace p

  union all

  select
    'CONTA', l.mk, l.id, l.nome, l.amb,
    l.compras, l.unidades, round(l.receita, 2), l.sem_receita,
    round(l.receita / nullif(l.compras - l.sem_receita, 0), 2),
    l.pedidos, round(l.recebido, 2), l.sem_recebido, l.atualizado
  from linhas_conta l;
end;
$$;

comment on function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[]) is
  'Vendas por marketplace e o consolidado, no SQL (D-436, C-53): linhas TOTAL, MARKETPLACE e CONTA. Somam compras (pack ML + pedido Shopee), unidades e receita bruta (pedidos Shopee de receita desconhecida a parte); ticket recalculado; pedidos ML e recebido Shopee so na linha do marketplace. Sandbox so em CONTA, nunca nas somas. p_marketplaces nulo = so ML; p_account_ids de marketplace_accounts.';

revoke all on function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[]) from public, anon;
grant execute on function public.get_marketplace_sales_summary(uuid, date, date, text[], uuid[]) to authenticated;

-- ------------------------------------------------------------
-- A serie diaria, para o grafico: por dia, uma linha por marketplace e a do
-- TOTAL, so com o que soma e so dias com venda (como get_sales_daily_series).
-- Mesmo escopo e mesmas regras do resumo.
-- ------------------------------------------------------------
create or replace function public.get_marketplace_sales_daily(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null
)
returns table (
  dia date,
  marketplace text,
  compras bigint,
  unidades bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  return query
  with
  por_dia as (
    select m.metric_date as d, 'ML'::text as mk,
           sum(m.purchases_count)::bigint as compras,
           sum(m.units_sold)::bigint as unidades,
           sum(m.gross_revenue) as receita,
           0::bigint as sem_receita
    from public.daily_account_metrics m
    join public.ml_accounts a on a.id = m.ml_account_id
    where 'ML' = any (v_marketplaces)
      and a.organization_id = p_organization_id
      and (p_account_ids is null or a.id = any (p_account_ids))
      and m.metric_date between p_date_from and p_date_to
    group by m.metric_date

    union all

    select v.dia, 'SHOPEE',
           count(*)::bigint,
           coalesce(sum(v.unidades), 0)::bigint,
           sum(v.receita_bruta),
           count(*) filter (where v.receita_bruta is null)::bigint
    from public.shopee_sales_orders v
    join public.shopee_shops s on s.id = v.shopee_shop_id
    where 'SHOPEE' = any (v_marketplaces)
      and v.organization_id = p_organization_id
      and s.environment = 'live'
      and (p_account_ids is null or s.id = any (p_account_ids))
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by v.dia
  )
  select p.d, p.mk, p.compras, p.unidades, round(p.receita, 2), p.sem_receita
  from por_dia p

  union all

  select p.d, null::text, sum(p.compras)::bigint, sum(p.unidades)::bigint, round(sum(p.receita), 2), sum(p.sem_receita)::bigint
  from por_dia p
  group by p.d

  order by 1, 2 nulls last;
end;
$$;

comment on function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[]) is
  'Serie diaria de vendas por marketplace e o total do dia (marketplace NULO), no SQL (D-436, C-53): compras, unidades, receita bruta e pedidos Shopee de receita desconhecida. So loja live; so dias com venda. p_marketplaces nulo = so ML.';

revoke all on function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[]) from public, anon;
grant execute on function public.get_marketplace_sales_daily(uuid, date, date, text[], uuid[]) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (secao 5T): as quatro metricas do
-- consolidado. As de cada canal continuam as de 5.2 (ML) e 5S (Shopee).
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('multicanal_compras', 'Compras (todos os marketplaces)',
   'SUM(daily_account_metrics.purchases_count) do ML + COUNT(pedidos Shopee validos)',
   'get_marketplace_sales_summary (daily_account_metrics, shopee_sales_orders)', array['account', 'organization'],
   'A unidade de compra do cliente: o pack do ML (pedidos_por_pack, 5.2) e o pedido da Shopee (um carrinho, 5S). Contas ML e lojas live ja lidas.',
   'Loja de sandbox e loja nunca lida. O "pedido" do ML (uma linha de item) nao entra: fica so na linha do ML.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('multicanal_unidades', 'Unidades vendidas (todos os marketplaces)',
   'SUM(daily_account_metrics.units_sold) do ML + SUM(quantity) dos pedidos Shopee validos',
   'get_marketplace_sales_summary', array['account', 'organization'],
   'unidades_vendidas (5.2) e shopee_unidades (5S), das contas e lojas do escopo.',
   'Loja de sandbox e loja nunca lida.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('multicanal_receita_bruta', 'Receita bruta (todos os marketplaces)',
   'SUM(daily_account_metrics.gross_revenue) do ML + SUM(receita bruta dos pedidos Shopee validos de receita conhecida)',
   'get_marketplace_sales_summary', array['account', 'organization'],
   'receita_bruta (5.2) e shopee_receita_bruta (5S): produtos com o desconto do vendedor, sem frete, nos dois.',
   'Pedido Shopee de receita desconhecida (bundle sem financeiro): fora da soma e contado a parte (pedidos_sem_receita). Sandbox e loja nunca lida. Devolucao nao reduz.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('multicanal_ticket_medio', 'Ticket medio (todos os marketplaces)',
   'multicanal_receita_bruta / (multicanal_compras - pedidos_sem_receita)',
   'get_marketplace_sales_summary', array['account', 'organization'],
   'Recalculado sobre a soma, so com as compras de receita conhecida.',
   'Media de medias. Compras de receita desconhecida (o denominador as exclui).',
   'excluded', 'America/Sao_Paulo', date '2026-10-14');
