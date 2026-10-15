-- ============================================================
-- D-455 -- Ads da Shopee (C-63): ROAS e ACOS so sobre os dias com o gasto E a
-- venda atribuida. Achado do A2: `sum()` ignora nulo, e um dia lido com
-- `broad_gmv` e sem `expense` (campo ausente na resposta) entrava so no
-- numerador -- ROAS acima do real, ACOS abaixo.
--
-- - `get_shopee_ads_overview` ganha `dias_sem_gasto` e `dias_sem_venda` (TOTAL
--   e por loja; nunca lida = NULO), e ROAS/ACOS passam a usar so os dias com
--   os dois campos. Investimento, vendas com Ads e TACoS nao mudam.
-- - `get_shopee_ads_daily`: o ROAS/ACOS do dia so sobre as lojas com os dois.
-- - Com os campos sempre presentes (o normal), tudo identico ao da D-449.
-- ============================================================

drop function public.get_shopee_ads_overview(uuid, date, date, uuid[]);

create function public.get_shopee_ads_overview(
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
  -- O periodo inteiro (ate hoje) dentro da leitura? Senao, os numeros sao so dos dias lidos.
  cobertura_completa boolean,
  dias_lidos bigint,
  -- Dias lidos sem o gasto / sem a venda atribuida (campo ausente na Shopee):
  -- ficam fora do ROAS e do ACOS, que so usam os dias com os dois.
  dias_sem_gasto bigint,
  dias_sem_venda bigint,
  investimento numeric,
  receita_ads numeric,
  receita_ads_direta numeric,
  pedidos_ads bigint,
  cliques bigint,
  impressoes bigint,
  roas numeric,
  acos numeric,
  receita_bruta numeric,
  tacos numeric,
  ultima_atualizacao timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_ate date := least(p_date_to, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment,
           s.ads_read_from, s.ads_read_until, s.ads_synced_at,
           s.ads_read_from is not null as lida,
           (s.ads_read_from is not null and p_date_from >= s.ads_read_from and v_ate <= s.ads_read_until) as coberta
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  ads as (
    select d.shopee_shop_id,
           count(*) as dias,
           sum(d.expense) as investimento,
           sum(d.broad_gmv) as receita_ads,
           sum(d.direct_gmv) as receita_direta,
           sum(d.broad_orders) as pedidos,
           sum(d.clicks) as cliques,
           sum(d.impressions) as impressoes,
           count(*) filter (where d.expense is null) as sem_gasto,
           count(*) filter (where d.broad_gmv is null) as sem_venda,
           -- ROAS e ACOS so sobre os dias com o gasto E a venda (D-455): um dia
           -- com venda e sem gasto entraria so no numerador.
           sum(d.expense) filter (where d.expense is not null and d.broad_gmv is not null) as invest_par,
           sum(d.broad_gmv) filter (where d.expense is not null and d.broad_gmv is not null) as receita_par
    from public.daily_shopee_ads_metrics d
    where d.organization_id = p_organization_id
      and d.shopee_shop_id in (select l.id from lojas l)
      and d.metric_date between p_date_from and p_date_to
    group by d.shopee_shop_id
  ),
  vendas as (
    -- A receita bruta conhecida das vendas validas da loja no periodo (5S),
    -- o denominador do TACoS.
    select v.shopee_shop_id, sum(v.receita_bruta) as receita
    from public.shopee_sales_orders v
    where v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by v.shopee_shop_id
  ),
  por_loja as (
    select
      l.id, l.nome, l.environment, l.lida, l.coberta, l.ads_synced_at,
      coalesce(a.dias, 0) as dias,
      -- Loja lida sem anuncio nos dias lidos: 0 (dentro da cobertura).
      case when l.lida then coalesce(a.investimento, 0) end as investimento,
      case when l.lida then coalesce(a.receita_ads, 0) end as receita_ads,
      case when l.lida then coalesce(a.receita_direta, 0) end as receita_direta,
      case when l.lida then coalesce(a.pedidos, 0) end as pedidos,
      case when l.lida then coalesce(a.cliques, 0) end as cliques,
      case when l.lida then coalesce(a.impressoes, 0) end as impressoes,
      case when l.lida then coalesce(a.sem_gasto, 0) end as sem_gasto,
      case when l.lida then coalesce(a.sem_venda, 0) end as sem_venda,
      case when l.lida then coalesce(a.invest_par, 0) end as invest_par,
      case when l.lida then coalesce(a.receita_par, 0) end as receita_par,
      coalesce(vd.receita, 0) as receita_bruta
    from lojas l
    left join ads a on a.shopee_shop_id = l.id
    left join vendas vd on vd.shopee_shop_id = l.id
  ),
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    bool_and(s.coberta),
    sum(s.dias)::bigint,
    sum(s.sem_gasto)::bigint,
    sum(s.sem_venda)::bigint,
    round(sum(s.investimento), 2),
    round(sum(s.receita_ads), 2),
    round(sum(s.receita_direta), 2),
    sum(s.pedidos)::bigint,
    sum(s.cliques)::bigint,
    sum(s.impressoes)::bigint,
    round(sum(s.receita_par) / nullif(sum(s.invest_par), 0), 4),
    round(sum(s.invest_par) / nullif(sum(s.receita_par), 0), 4),
    round(sum(s.receita_bruta), 2),
    round(sum(s.investimento) / nullif(sum(s.receita_bruta), 0), 4),
    case when bool_or(s.ads_synced_at is null) then null else min(s.ads_synced_at) end
  from somaveis s
  having count(*) > 0

  union all

  -- Por loja. Ads nunca lido: tudo NULO.
  select
    'CONTA', pl.id, pl.nome, pl.environment,
    case when pl.lida then pl.coberta end,
    case when pl.lida then pl.dias end::bigint,
    pl.sem_gasto::bigint,
    pl.sem_venda::bigint,
    round(pl.investimento, 2),
    round(pl.receita_ads, 2),
    round(pl.receita_direta, 2),
    pl.pedidos::bigint,
    pl.cliques::bigint,
    pl.impressoes::bigint,
    round(pl.receita_par / nullif(pl.invest_par, 0), 4),
    round(pl.invest_par / nullif(pl.receita_par, 0), 4),
    case when pl.lida then round(pl.receita_bruta, 2) end,
    round(pl.investimento / nullif(pl.receita_bruta, 0), 4),
    pl.ads_synced_at
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_ads_overview(uuid, date, date, uuid[]) is
  'D-449 (C-63), D-455: Ads CPC da loja Shopee no periodo -- investimento, vendas com Ads (amplo e direto), pedidos, cliques, impressoes, ROAS e ACOS so sobre os dias com o gasto e a venda (dias_sem_gasto/dias_sem_venda contam os outros) e TACoS sobre a receita bruta das vendas validas; TOTAL so de loja live com Ads lido; cobertura_completa diz se o periodo inteiro esta na leitura. NAO e o total de Ads (o GMV Max de loja pode ficar de fora). security invoker.';

revoke all on function public.get_shopee_ads_overview(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_ads_overview(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- A serie diaria (so lojas live com Ads lido; dia sem linha nao aparece).
-- ------------------------------------------------------------
create or replace function public.get_shopee_ads_daily(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  dia date,
  investimento numeric,
  receita_ads numeric,
  receita_ads_direta numeric,
  pedidos_ads bigint,
  cliques bigint,
  impressoes bigint,
  roas numeric,
  acos numeric
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
  select
    d.metric_date,
    round(sum(d.expense), 2),
    round(sum(d.broad_gmv), 2),
    round(sum(d.direct_gmv), 2),
    sum(d.broad_orders)::bigint,
    sum(d.clicks)::bigint,
    sum(d.impressions)::bigint,
    round(sum(d.broad_gmv) filter (where d.expense is not null and d.broad_gmv is not null)
      / nullif(sum(d.expense) filter (where d.expense is not null and d.broad_gmv is not null), 0), 4),
    round(sum(d.expense) filter (where d.expense is not null and d.broad_gmv is not null)
      / nullif(sum(d.broad_gmv) filter (where d.expense is not null and d.broad_gmv is not null), 0), 4)
  from public.daily_shopee_ads_metrics d
  join public.shopee_shops s on s.id = d.shopee_shop_id
  where d.organization_id = p_organization_id
    and s.environment = 'live'
    and (p_account_ids is null or d.shopee_shop_id = any (p_account_ids))
    and d.metric_date between p_date_from and p_date_to
  group by d.metric_date
  order by d.metric_date;
end;
$$;

comment on function public.get_shopee_ads_daily(uuid, date, date, uuid[]) is
  'D-449 (C-63): Ads CPC da loja Shopee por dia, so lojas live; a soma dos dias fecha com o TOTAL de get_shopee_ads_overview. security invoker.';

revoke all on function public.get_shopee_ads_daily(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_ads_daily(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (5V): ROAS e ACOS so sobre os dias com os dois.
-- ------------------------------------------------------------
update public.metric_definitions
   set formula = 'SUM(broad_gmv) / NULLIF(SUM(expense), 0), so sobre os dias com o gasto E a venda atribuida (D-455)',
       exclusions = 'Venda sobre investimento, nao lucro. NULO sem investimento. Dia lido sem um dos dois campos fica fora (dias_sem_gasto/dias_sem_venda o contam).',
       definition_updated_on = date '2026-10-15'
 where id = 'shopee_roas';

update public.metric_definitions
   set formula = 'SUM(expense) / NULLIF(SUM(broad_gmv), 0), so sobre os dias com o gasto E a venda atribuida (D-455)',
       exclusions = 'NULO sem venda com Ads. Dia lido sem um dos dois campos fica fora (dias_sem_gasto/dias_sem_venda o contam).',
       definition_updated_on = date '2026-10-15'
 where id = 'shopee_acos';
