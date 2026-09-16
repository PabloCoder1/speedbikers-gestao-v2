-- ============================================================
-- Mercado Ads (Product Ads) no /faturamento -- D-363.
--
-- Ads estava ADIADO desde D-059 ("exige advertiser_id por conta, sem evidencia
-- de que a conta tenha o produto habilitado"). O dono confirmou em 16/09/2026
-- que anuncia no Mercado Ads e pediu analise de campanhas no Faturamento.
--
-- Fonte: API oficial de Product Ads (doc "Product Ads para Catalogo e User
-- Products", lida em 16/09/2026). Tres fatos da doc decidem este arquivo:
--
--   1. a conta pode NAO ter Product Ads habilitado (404 "No permissions found")
--      -- e um ESTADO que a tela precisa dizer, por isso `ads_advertisers`
--      guarda o resultado de cada verificacao, inclusive o negativo;
--   2. metricas so existem 90 dias para tras e sao atualizadas as 10h (GMT-3)
--      -- o sync regrava a janela inteira por UPSERT, entao corrigir um dia
--      depois nao duplica nada;
--   3. as metricas por dia vem POR CAMPANHA (detalhe da campanha com
--      aggregation_type=DAILY) -- o grao gravado e (conta, campanha, dia).
--
-- Tres tabelas, todas com RLS por CONTA (has_account_access) e grants no
-- padrao apertado de 20260831160501 (order_financials): authenticated so le,
-- service_role (worker) le e escreve.
-- ============================================================

-- ------------------------------------------------------------
-- A verificacao do anunciante, por conta. Guarda tambem o "nao habilitado".
-- ------------------------------------------------------------
create table public.ads_advertisers (
  ml_account_id uuid primary key references public.ml_accounts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null check (status in ('habilitado', 'nao_habilitado')),
  advertiser_id bigint check (advertiser_id is null or advertiser_id > 0),
  site_id text,
  checked_at timestamptz not null default now(),
  constraint ads_advertisers_habilitado_tem_id
    check ((status = 'habilitado') = (advertiser_id is not null and site_id is not null))
);

comment on table public.ads_advertisers is
  'Resultado da ultima verificacao de Product Ads por conta (D-363): habilitado com advertiser_id, ou nao_habilitado (404 da API). Sem linha = nunca verificado.';

-- ------------------------------------------------------------
-- As campanhas, como vieram na ultima leitura (projecao mutavel).
-- ------------------------------------------------------------
create table public.ads_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  campaign_id bigint not null check (campaign_id > 0),
  name text not null,
  status text not null,
  strategy text,
  -- Orcamento diario medio, na moeda da conta. Nulo = a API nao informou.
  budget numeric(14, 2),
  roas_target numeric(10, 2),
  acos_target numeric(10, 2),
  synced_at timestamptz not null default now(),
  constraint ads_campaigns_account_campaign_unique unique (ml_account_id, campaign_id)
);

comment on table public.ads_campaigns is
  'Campanhas de Product Ads por conta, na ultima sincronizacao (D-363). roas_target e o objetivo padrao desde 2026; acos_target fica por compatibilidade.';

-- ------------------------------------------------------------
-- Metricas por (conta, campanha, dia). Dia sem linha = sem metrica lida.
-- ------------------------------------------------------------
create table public.daily_ads_campaign_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  campaign_id bigint not null check (campaign_id > 0),
  metric_date date not null,
  clicks bigint not null check (clicks >= 0),
  prints bigint not null check (prints >= 0),
  -- "Investimento": soma do custo dos cliques (glossario da doc).
  cost numeric(14, 2) not null check (cost >= 0),
  direct_amount numeric(14, 2) not null check (direct_amount >= 0),
  indirect_amount numeric(14, 2) not null check (indirect_amount >= 0),
  total_amount numeric(14, 2) not null check (total_amount >= 0),
  direct_units bigint not null check (direct_units >= 0),
  indirect_units bigint not null check (indirect_units >= 0),
  units bigint not null check (units >= 0),
  -- Vendas sem publicidade das publicacoes promovidas. Nulo = nao veio.
  organic_units bigint check (organic_units is null or organic_units >= 0),
  organic_amount numeric(14, 2) check (organic_amount is null or organic_amount >= 0),
  synced_at timestamptz not null default now(),
  constraint daily_ads_campaign_metrics_unique unique (ml_account_id, campaign_id, metric_date)
);

comment on table public.daily_ads_campaign_metrics is
  'Metricas diarias de Product Ads por campanha (D-363), lidas do detalhe da campanha com aggregation_type=DAILY. A janela de 90 dias e regravada por upsert a cada sincronizacao; dia sem linha = sem metrica lida, nunca investimento zero.';

create index ads_campaigns_org_idx on public.ads_campaigns (organization_id);
create index daily_ads_campaign_metrics_account_date_idx
  on public.daily_ads_campaign_metrics (ml_account_id, metric_date);
create index daily_ads_campaign_metrics_org_date_idx
  on public.daily_ads_campaign_metrics (organization_id, metric_date);

alter table public.ads_advertisers enable row level security;
alter table public.ads_campaigns enable row level security;
alter table public.daily_ads_campaign_metrics enable row level security;

create policy ads_advertisers_select_permitted
  on public.ads_advertisers for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy ads_campaigns_select_permitted
  on public.ads_campaigns for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy daily_ads_campaign_metrics_select_permitted
  on public.daily_ads_campaign_metrics for select to authenticated
  using (private.has_account_access(ml_account_id));

revoke all on public.ads_advertisers from anon, authenticated, service_role;
revoke all on public.ads_campaigns from anon, authenticated, service_role;
revoke all on public.daily_ads_campaign_metrics from anon, authenticated, service_role;

grant select on public.ads_advertisers to authenticated;
grant select on public.ads_campaigns to authenticated;
grant select on public.daily_ads_campaign_metrics to authenticated;

grant select, insert, update on public.ads_advertisers to service_role;
grant select, insert, update on public.ads_campaigns to service_role;
grant select, insert, update on public.daily_ads_campaign_metrics to service_role;

-- ------------------------------------------------------------
-- O sync ganha observabilidade (sync_runs/sync_errors) -- sexto alargamento
-- deste CHECK, mesmo formato dos anteriores.
-- ------------------------------------------------------------
alter table public.sync_runs drop constraint sync_runs_resource_check;
alter table public.sync_runs add constraint sync_runs_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages', 'claims', 'order_financials', 'ads']));

alter table public.sync_errors drop constraint sync_errors_resource_check;
alter table public.sync_errors add constraint sync_errors_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages', 'claims', 'order_financials', 'ads']));

-- ------------------------------------------------------------
-- Catalogo (D-023): as metricas de Ads que METRICS.md listava como pendentes.
-- cancellation_treatment = 'included': o numero e o que a API do Mercado Livre
-- devolve; a doc nao descreve reversao de venda cancelada, e o sistema nao
-- reprocessa a atribuicao.
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('investimento_ads', 'Investimento em Ads',
   'SUM(daily_ads_campaign_metrics.cost)',
   'API de Product Ads do Mercado Livre, detalhe da campanha com aggregation_type=DAILY',
   array['account', 'organization'],
   'Custo dos cliques das campanhas de Product Ads no periodo',
   'Brand Ads e Display Ads; dias sem metrica lida',
   'included', 'America/Sao_Paulo', date '2026-09-16'),
  ('receita_ads', 'Receita com Ads',
   'SUM(daily_ads_campaign_metrics.total_amount)',
   'API de Product Ads do Mercado Livre (direct_amount + indirect_amount)',
   array['account', 'organization'],
   'Vendas diretas e indiretas como o Mercado Livre as atribui aos cliques; a doc nao diz se venda cancelada sai depois',
   'Vendas organicas das publicacoes promovidas',
   'included', 'America/Sao_Paulo', date '2026-09-16'),
  ('acos', 'ACOS',
   'investimento_ads / NULLIF(receita_ads, 0)',
   'Componentes canonicos acima',
   array['account', 'organization'],
   'Mesmas campanhas e dias',
   'Media de ACOS diarios ou de campanhas',
   'included', 'America/Sao_Paulo', date '2026-09-16'),
  ('roas', 'ROAS',
   'receita_ads / NULLIF(investimento_ads, 0)',
   'Componentes canonicos acima',
   array['account', 'organization'],
   'Mesmas campanhas e dias',
   'Media de ROAS diarios ou de campanhas',
   'included', 'America/Sao_Paulo', date '2026-09-16'),
  ('tacos', 'TACoS',
   'investimento_ads / NULLIF(receita_bruta, 0)',
   'investimento_ads + receita_bruta (5.2), mesmo periodo e contas',
   array['account', 'organization'],
   'Todo o investimento em Ads contra toda a receita bruta das vendas validas',
   'Media de medias',
   'included', 'America/Sao_Paulo', date '2026-09-16')
on conflict (id) do update set
  name = excluded.name, formula = excluded.formula, source = excluded.source,
  granularities = excluded.granularities, inclusions = excluded.inclusions,
  exclusions = excluded.exclusions, cancellation_treatment = excluded.cancellation_treatment,
  timezone = excluded.timezone, definition_updated_on = excluded.definition_updated_on;

-- ------------------------------------------------------------
-- A leitura do /faturamento: resumo, campanhas, serie diaria e a cobertura
-- (quais contas tem Ads habilitado, quais nunca foram verificadas).
-- ------------------------------------------------------------
create function public.get_ads_overview(
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
as $fn$
declare
  resultado jsonb;
begin
  with contas as (
    -- RLS de ml_accounts decide o que a pessoa ve; o filtro de conta estreita.
    select a.id, a.label, a.status as conta_status
    from public.ml_accounts a
    where (p_ml_account_id is null or a.id = p_ml_account_id)
  ),
  metricas as (
    select m.*
    from public.daily_ads_campaign_metrics m
    join contas c on c.id = m.ml_account_id
    where m.metric_date between p_date_from and p_date_to
  ),
  receita as (
    -- A receita bruta das vendas validas, para o TACoS (5.2), mesmas contas e dias.
    select coalesce(sum(d.gross_revenue), 0) as receita_bruta
    from public.daily_account_metrics d
    join contas c on c.id = d.ml_account_id
    where d.metric_date between p_date_from and p_date_to
  ),
  por_campanha as (
    select
      m.ml_account_id, m.campaign_id,
      sum(m.cost) as investimento, sum(m.total_amount) as receita_ads,
      sum(m.direct_amount) as receita_direta, sum(m.indirect_amount) as receita_indireta,
      sum(m.clicks) as cliques, sum(m.prints) as impressoes, sum(m.units) as unidades,
      count(*) as dias
    from metricas m
    group by m.ml_account_id, m.campaign_id
  ),
  resumo as (
    select
      coalesce(sum(m.cost), 0) as investimento,
      coalesce(sum(m.total_amount), 0) as receita_ads,
      coalesce(sum(m.direct_amount), 0) as receita_direta,
      coalesce(sum(m.indirect_amount), 0) as receita_indireta,
      coalesce(sum(m.clicks), 0) as cliques,
      coalesce(sum(m.prints), 0) as impressoes,
      coalesce(sum(m.units), 0) as unidades,
      count(distinct (m.ml_account_id, m.campaign_id)) as campanhas_com_metrica
    from metricas m
  )
  select jsonb_build_object(
    'resumo', (
      select jsonb_build_object(
        'investimento', round(r.investimento, 2),
        'receita_ads', round(r.receita_ads, 2),
        'receita_direta', round(r.receita_direta, 2),
        'receita_indireta', round(r.receita_indireta, 2),
        'cliques', r.cliques,
        'impressoes', r.impressoes,
        'unidades', r.unidades,
        'campanhas_com_metrica', r.campanhas_com_metrica,
        'acos', round(r.investimento / nullif(r.receita_ads, 0), 4),
        'roas', round(r.receita_ads / nullif(r.investimento, 0), 2),
        'ctr', round(r.cliques::numeric / nullif(r.impressoes, 0), 4),
        'cpc', round(r.investimento / nullif(r.cliques, 0), 2),
        'receita_bruta', round(rb.receita_bruta, 2),
        'tacos', round(r.investimento / nullif(rb.receita_bruta, 0), 4)
      )
      from resumo r cross join receita rb
    ),
    'campanhas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'ml_account_id', p.ml_account_id,
          'conta', c.label,
          'campaign_id', p.campaign_id,
          'nome', coalesce(ca.name, 'campanha ' || p.campaign_id::text),
          'status', ca.status,
          'estrategia', ca.strategy,
          'orcamento', ca.budget,
          'roas_alvo', ca.roas_target,
          'investimento', round(p.investimento, 2),
          'receita_ads', round(p.receita_ads, 2),
          'receita_direta', round(p.receita_direta, 2),
          'receita_indireta', round(p.receita_indireta, 2),
          'cliques', p.cliques,
          'impressoes', p.impressoes,
          'unidades', p.unidades,
          'acos', round(p.investimento / nullif(p.receita_ads, 0), 4),
          'roas', round(p.receita_ads / nullif(p.investimento, 0), 2)
        ) order by p.investimento desc, p.receita_ads desc)
      from por_campanha p
      join contas c on c.id = p.ml_account_id
      left join public.ads_campaigns ca
        on ca.ml_account_id = p.ml_account_id and ca.campaign_id = p.campaign_id
    ), '[]'::jsonb),
    'diario', coalesce((
      select jsonb_agg(jsonb_build_object(
          'dia', d.metric_date, 'investimento', round(d.investimento, 2), 'receita_ads', round(d.receita_ads, 2)
        ) order by d.metric_date)
      from (
        select m.metric_date, sum(m.cost) as investimento, sum(m.total_amount) as receita_ads
        from metricas m group by m.metric_date
      ) d
    ), '[]'::jsonb),
    'contas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'ml_account_id', c.id,
          'conta', c.label,
          'ads', coalesce(ad.status, 'nao_verificado'),
          'verificado_em', ad.checked_at
        ) order by c.label)
      from contas c
      left join public.ads_advertisers ad on ad.ml_account_id = c.id
      where c.conta_status = 'CONNECTED'
    ), '[]'::jsonb),
    'sincronizado_em', (
      select max(m.synced_at)
      from public.daily_ads_campaign_metrics m
      join contas c on c.id = m.ml_account_id
    )
  )
  into resultado;

  return resultado;
end
$fn$;

comment on function public.get_ads_overview(date, date, uuid) is
  'Mercado Ads no /faturamento (D-363): resumo (investimento, receita com Ads, ACOS, ROAS, CTR, CPC, TACoS contra a receita bruta das vendas validas), campanhas ordenadas por investimento, serie diaria e o estado de Product Ads por conta conectada. Razoes sobre as somas, NULL com denominador zero. security invoker: RLS por conta.';

revoke all on function public.get_ads_overview(date, date, uuid) from public, anon;
grant execute on function public.get_ads_overview(date, date, uuid) to authenticated, service_role;
