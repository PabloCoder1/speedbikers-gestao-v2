-- ============================================================
-- D-449 -- Ads da Shopee (etapa E7b da frente multicanal; contrato C-63).
-- A segunda fonte financeira que faltava (R9): o desempenho DIARIO dos
-- anuncios CPC da loja (`v2.ads.get_all_cpc_ads_daily_performance`,
-- conferido na referencia oficial e no "Shopee On-Platform Ads API Guide" em
-- 14/10/2026).
--
-- - `daily_shopee_ads_metrics`: uma linha por loja e dia, como a Shopee
--   manda: impressoes, cliques, pedidos, itens e GMV atribuidos ao anuncio
--   (DIRETO = o item clicado; AMPLO = qualquer item da loja ate 7 dias depois
--   do clique) e o gasto (`expense`). Campo ausente fica NULO.
-- - E "Ads CPC da loja", NAO o total de Ads: os anuncios GMV Max de loja tem
--   consulta propria, que so devolve o agregado do periodo, e a documentacao
--   nao diz se o gasto deles esta aqui. Por isso nada aqui entra no resultado
--   da venda: o "resultado apos Ads" da Shopee espera a conferencia com loja
--   real (Go Live).
-- - A COBERTURA da leitura (`ads_read_from`/`ads_read_until`): dia dentro
--   dela sem linha e dia sem anuncio (0); fora dela, desconhecido. O
--   resumo diz se o periodo esta inteiro coberto.
-- - A leitura relida sobrescreve: o GMV atribuido muda ate 7 dias depois do
--   clique, e o worker rele as duas ultimas semanas.
-- ============================================================

alter table public.shopee_shops
  add column if not exists ads_read_from date,
  add column if not exists ads_read_until date,
  add column if not exists ads_synced_at timestamptz;

comment on column public.shopee_shops.ads_read_from is
  'Primeiro dia (Sao Paulo) do desempenho de Ads da loja ja lido (D-449). NULO = nunca lido.';
comment on column public.shopee_shops.ads_read_until is
  'Ultimo dia (Sao Paulo) do desempenho de Ads da loja ja lido (D-449). Dentro de [from, until], dia sem linha e dia sem anuncio.';
comment on column public.shopee_shops.ads_synced_at is
  'Quando o desempenho de Ads da loja foi lido pela ultima vez (D-449).';

create table public.daily_shopee_ads_metrics (
  shopee_shop_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  metric_date date not null,
  impressions bigint check (impressions is null or impressions >= 0),
  clicks bigint check (clicks is null or clicks >= 0),
  direct_orders bigint check (direct_orders is null or direct_orders >= 0),
  broad_orders bigint check (broad_orders is null or broad_orders >= 0),
  direct_items bigint check (direct_items is null or direct_items >= 0),
  broad_items bigint check (broad_items is null or broad_items >= 0),
  -- GMV atribuido ao anuncio: direto (o item clicado) e amplo (a loja toda).
  direct_gmv numeric(14, 2) check (direct_gmv is null or direct_gmv >= 0),
  broad_gmv numeric(14, 2) check (broad_gmv is null or broad_gmv >= 0),
  -- O gasto com os anuncios CPC da loja no dia.
  expense numeric(14, 2) check (expense is null or expense >= 0),
  synced_at timestamptz not null default now(),
  primary key (shopee_shop_id, metric_date),
  constraint daily_shopee_ads_metrics_loja_da_organizacao
    foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade
);

create index daily_shopee_ads_metrics_org_date_idx on public.daily_shopee_ads_metrics (organization_id, metric_date);

comment on table public.daily_shopee_ads_metrics is
  'Desempenho diario dos anuncios CPC da loja Shopee (D-449), como a API manda. NAO e o total de Ads: o GMV Max de loja pode ficar de fora.';

alter table public.daily_shopee_ads_metrics enable row level security;

create policy daily_shopee_ads_metrics_select_permitted
  on public.daily_shopee_ads_metrics for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

revoke all on public.daily_shopee_ads_metrics from anon, authenticated;
grant select on public.daily_shopee_ads_metrics to authenticated;
grant all on public.daily_shopee_ads_metrics to service_role;

-- ------------------------------------------------------------
-- A gravacao de uma leitura: os dias lidos (sobrescritos) e a cobertura.
-- ------------------------------------------------------------
create or replace function public.shopee_upsert_ads_days(
  p_shopee_shop_id uuid,
  p_dias jsonb,
  p_read_from date,
  p_read_until date,
  p_synced_at timestamptz default now()
) returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_org uuid;
  v_gravados integer;
begin
  select organization_id into v_org from public.shopee_shops where id = p_shopee_shop_id;

  if v_org is null then
    raise exception 'loja shopee % nao encontrada', p_shopee_shop_id;
  end if;

  if p_dias is null or jsonb_typeof(p_dias) <> 'array' then
    raise exception 'p_dias precisa ser um array';
  end if;

  if p_read_from is null or p_read_until is null or p_read_until < p_read_from then
    raise exception 'leitura invalida: % a %', p_read_from, p_read_until;
  end if;

  with entrada as (
    select distinct on (e.metric_date) e.*
    from jsonb_to_recordset(p_dias) as e (
      metric_date date,
      impressions bigint,
      clicks bigint,
      direct_orders bigint,
      broad_orders bigint,
      direct_items bigint,
      broad_items bigint,
      direct_gmv numeric,
      broad_gmv numeric,
      expense numeric
    )
    -- Dia fora da janela pedida nao entra: a cobertura e a da janela.
    where e.metric_date between p_read_from and p_read_until
    order by e.metric_date
  ),
  gravados as (
    insert into public.daily_shopee_ads_metrics as d (
      shopee_shop_id, organization_id, metric_date, impressions, clicks, direct_orders, broad_orders,
      direct_items, broad_items, direct_gmv, broad_gmv, expense, synced_at
    )
    select p_shopee_shop_id, v_org, e.metric_date, e.impressions, e.clicks, e.direct_orders, e.broad_orders,
           e.direct_items, e.broad_items, e.direct_gmv, e.broad_gmv, e.expense, p_synced_at
    from entrada e
    on conflict (shopee_shop_id, metric_date) do update set
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      direct_orders = excluded.direct_orders,
      broad_orders = excluded.broad_orders,
      direct_items = excluded.direct_items,
      broad_items = excluded.broad_items,
      direct_gmv = excluded.direct_gmv,
      broad_gmv = excluded.broad_gmv,
      expense = excluded.expense,
      synced_at = excluded.synced_at
    -- A leitura mais nova vale (o GMV atribuido muda ate 7 dias depois).
    where d.synced_at <= excluded.synced_at
    returning 1
  )
  select count(*)::integer into v_gravados from gravados;

  -- A cobertura so cresce: a janela lida junta-se a ja lida.
  update public.shopee_shops
     set ads_read_from = least(coalesce(ads_read_from, p_read_from), p_read_from),
         ads_read_until = greatest(coalesce(ads_read_until, p_read_until), p_read_until),
         ads_synced_at = greatest(coalesce(ads_synced_at, p_synced_at), p_synced_at)
   where id = p_shopee_shop_id;

  return v_gravados;
end;
$$;

comment on function public.shopee_upsert_ads_days(uuid, jsonb, date, date, timestamptz) is
  'Grava uma leitura do desempenho diario de Ads de uma loja Shopee (D-449): os dias da janela, sobrescritos pela leitura mais nova, e a cobertura da leitura (so cresce). So o worker (service_role).';

revoke all on function public.shopee_upsert_ads_days(uuid, jsonb, date, date, timestamptz) from public, anon, authenticated;
grant execute on function public.shopee_upsert_ads_days(uuid, jsonb, date, date, timestamptz) to service_role;

-- ------------------------------------------------------------
-- O resumo: TOTAL (loja live com Ads ja lido) e por loja.
-- ------------------------------------------------------------
create or replace function public.get_shopee_ads_overview(
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
           sum(d.impressions) as impressoes
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
    round(sum(s.investimento), 2),
    round(sum(s.receita_ads), 2),
    round(sum(s.receita_direta), 2),
    sum(s.pedidos)::bigint,
    sum(s.cliques)::bigint,
    sum(s.impressoes)::bigint,
    round(sum(s.receita_ads) / nullif(sum(s.investimento), 0), 4),
    round(sum(s.investimento) / nullif(sum(s.receita_ads), 0), 4),
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
    round(pl.investimento, 2),
    round(pl.receita_ads, 2),
    round(pl.receita_direta, 2),
    pl.pedidos::bigint,
    pl.cliques::bigint,
    pl.impressoes::bigint,
    round(pl.receita_ads / nullif(pl.investimento, 0), 4),
    round(pl.investimento / nullif(pl.receita_ads, 0), 4),
    case when pl.lida then round(pl.receita_bruta, 2) end,
    round(pl.investimento / nullif(pl.receita_bruta, 0), 4),
    pl.ads_synced_at
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_ads_overview(uuid, date, date, uuid[]) is
  'D-449 (C-63): Ads CPC da loja Shopee no periodo -- investimento, vendas com Ads (amplo e direto), pedidos, cliques, impressoes, ROAS, ACOS e TACoS sobre a receita bruta das vendas validas; TOTAL so de loja live com Ads lido; cobertura_completa diz se o periodo inteiro esta na leitura. NAO e o total de Ads (o GMV Max de loja pode ficar de fora). security invoker.';

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
    round(sum(d.broad_gmv) / nullif(sum(d.expense), 0), 4),
    round(sum(d.expense) / nullif(sum(d.broad_gmv), 0), 4)
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
-- O espelho de docs/METRICS.md (5V).
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_investimento_ads', 'Investimento em Ads CPC na Shopee',
   'SUM(daily_shopee_ads_metrics.expense)',
   'get_shopee_ads_overview (v2.ads.get_all_cpc_ads_daily_performance)', array['account', 'organization'],
   'O gasto dos anuncios CPC da loja por dia, como a Shopee manda; lojas live com Ads lido.',
   'NAO e o total de Ads: o GMV Max de loja tem consulta propria e pode ficar de fora. Nao entra no resultado da venda ate a conferencia com loja real.',
   'included', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_receita_ads', 'Vendas com Ads na Shopee',
   'SUM(daily_shopee_ads_metrics.broad_gmv) (amplo); o direto a parte',
   'get_shopee_ads_overview', array['account', 'organization'],
   'Atribuicao da Shopee: amplo = qualquer item da loja ate 7 dias depois do clique; direto = o item clicado.',
   'E a atribuicao da Shopee, nao a receita das vendas; muda ate 7 dias depois do clique.',
   'included', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_roas', 'ROAS na Shopee',
   'shopee_receita_ads / NULLIF(shopee_investimento_ads, 0)',
   'get_shopee_ads_overview', array['account', 'organization'],
   'Sobre as somas, nunca media de dias.',
   'Venda sobre investimento, nao lucro. NULO sem investimento.',
   'included', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_acos', 'ACOS na Shopee',
   'shopee_investimento_ads / NULLIF(shopee_receita_ads, 0)',
   'get_shopee_ads_overview', array['account', 'organization'],
   'Fracao, sobre as somas.',
   'NULO sem venda com Ads.',
   'included', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_tacos', 'TACoS na Shopee',
   'shopee_investimento_ads / NULLIF(receita bruta das vendas validas, 0)',
   'get_shopee_ads_overview (shopee_sales_orders)', array['account', 'organization'],
   'O investimento contra toda a receita bruta conhecida das vendas validas das mesmas lojas e dias (5S).',
   'NULO sem receita.',
   'included', 'America/Sao_Paulo', date '2026-10-14');
