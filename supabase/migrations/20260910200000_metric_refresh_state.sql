-- ============================================================
-- O CARIMBO QUE PAROU DE ANDAR (D-304).
--
-- SINTOMA, trazido pelo usuário com a captura da tela: `/vendas` dizendo
-- "Cálculo desatualizado · até 10/09/2026, 01:02" às duas da tarde.
--
-- MEDIDO na produção em 2026-09-10 17:55 UTC, antes de escrever uma linha:
--
--   * `analytics.recompute` rodou **1.357 vezes em 24h**, todas 'done', com
--     QUATRO chaves por hora carregando a data de hoje -- uma por conta --,
--     escrevendo 325 linhas nas últimas três horas. O pipeline está VIVO;
--   * a linha de conta de hoje tem `computed_at` = 04:02 UTC (01:02 em São
--     Paulo, exatamente o que a tela mostra) e `xmin` de uma transação das
--     **17:01** -- ou seja, ela FOI escrita e o carimbo não andou;
--   * todo dia, em todas as quatro contas, `computed_at` é ~00:0x e nunca
--     mais muda.
--
-- CAUSA: D-199 (`20260902115548_metrics_converge_instead_of_rewrite.sql`)
-- trocou DELETE+INSERT por `insert ... on conflict do update ... where a
-- linha DIFERE`, e os três `do update set` atualizam os VALORES sem tocar
-- `computed_at`. A coluna só recebe valor pelo `default now()` do INSERT.
-- `computed_at` deixou de significar "quando foi calculado" e passou a
-- significar "quando a linha nasceu" -- e o selo de frescor, que compara com
-- 3h/12h, passou a mentir todo santo dia depois do meio-dia.
--
-- ------------------------------------------------------------
-- POR QUE NÃO É SÓ ACRESCENTAR `computed_at = now()` NO UPSERT
-- ------------------------------------------------------------
--
-- Porque isso responde a pergunta errada. Existem DUAS perguntas, e a tela
-- precisa da segunda:
--
--   1. "quando este número mudou pela última vez?"  -> `computed_at`
--   2. "quando alguém conferiu que ele ainda é este?" -> não existia
--
-- Numa madrugada sem venda, a resposta certa para (1) é "ontem" e para (2) é
-- "há dois minutos". Carimbar o valor no upsert responderia (1) de novo e o
-- selo continuaria vermelho na noite em que TUDO está certo.
--
-- E há o custo: D-199 nasceu de uma medição -- 485 mil escritas/dia nas duas
-- tabelas de grão fino, com o decodificador de WAL do Realtime em 43,4% do
-- tempo do banco. Carimbar toda linha a cada passada traria as 485 mil de
-- volta. **Uma linha por conta por passada** custa ~57 escritas/hora contra
-- as 4 contas de hoje. É a mesma informação por três ordens de grandeza menos
-- escrita.
--
-- ------------------------------------------------------------
-- O QUE ESTA TABELA É, E O QUE ELA NÃO É
-- ------------------------------------------------------------
--
-- É o ESTADO do recálculo por conta: quando passou, quando mudou alguma
-- coisa, e quanto escreveu na última passada. Não é telemetria de execução --
-- isso é `job_runs`, que continua sendo a fonte de "o que rodou". Aqui cabe
-- uma linha por conta, para sempre, e ela é lida por tela.
--
-- `last_change_at` existe para a pergunta (1) no grão da conta, sem varrer as
-- métricas: é o que separa "não mudou porque nada vendeu" de "não mudou
-- porque o cálculo parou". Quem responde a segunda é `last_refresh_at`.
-- ============================================================

create table public.metric_refresh_state (
  ml_account_id uuid primary key references public.ml_accounts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Toda passada do recálculo escreve aqui, mude ou não mude número nenhum.
  -- É este o campo que responde "o cálculo está vivo?".
  last_refresh_at timestamptz not null default now(),

  -- Só quando a passada escreveu alguma linha. Nulo enquanto a conta nunca
  -- teve mudança registrada -- o que é diferente de nunca ter sido conferida.
  last_change_at timestamptz,

  -- Linhas efetivamente escritas na ÚLTIMA passada (o `v_affected` de D-199).
  -- Zero é o valor saudável mais comum: significa "conferi e estava tudo no
  -- lugar".
  last_rows_written integer not null default 0 check (last_rows_written >= 0)
);

comment on table public.metric_refresh_state is
  'Estado do recalculo de metricas por conta (D-304): quando passou, quando mudou e quanto escreveu. Separa "o numero mudou" de "o numero foi conferido" -- a segunda pergunta e a que o selo de frescor das telas precisa, e a que computed_at deixou de responder em D-199.';

comment on column public.metric_refresh_state.last_refresh_at is
  'Ultima passada do recalculo, tenha ela escrito ou nao. Fonte do selo de frescor.';

comment on column public.metric_refresh_state.last_change_at is
  'Ultima passada que EFETIVAMENTE escreveu. Nulo enquanto nenhuma escreveu.';

-- ------------------------------------------------------------
-- RLS: o mesmo alcance por conta das tabelas de metrica (D-117)
-- ------------------------------------------------------------

alter table public.metric_refresh_state enable row level security;

-- A FORMA É A DE CONJUNTO, não a escalar (D-181): `private.has_account_access`
-- continua certa DENTRO de uma RPC que valida uma conta específica, e errada
-- numa policy, onde recebe uma coluna e vira chamada por linha. Há guarda de
-- integração reprovando a volta da forma escalar em qualquer policy.
create policy metric_refresh_state_select_permitted
  on public.metric_refresh_state for select to authenticated
  using (ml_account_id in (select private.accessible_accounts()));

revoke all on public.metric_refresh_state from anon, authenticated, service_role;
grant select on public.metric_refresh_state to authenticated;
grant select, insert, update, delete on public.metric_refresh_state to service_role;

-- ------------------------------------------------------------
-- SEMENTE: nenhuma conta pode nascer sem estado
--
-- Sem esta semente, a leitura de frescor devolveria NULO para as quatro
-- contas ate o primeiro recalculo pos-deploy -- e NULO, nas telas desta casa,
-- significa "nunca calculado", que seria uma segunda mentira no lugar da
-- primeira. O valor semeado e o que se sabe de verdade hoje: o maior
-- `computed_at` que a conta tem.
-- ------------------------------------------------------------

insert into public.metric_refresh_state (ml_account_id, organization_id, last_refresh_at, last_change_at, last_rows_written)
select m.ml_account_id, m.organization_id, max(m.computed_at), max(m.computed_at), 0
from public.daily_account_metrics m
group by m.ml_account_id, m.organization_id
on conflict (ml_account_id) do nothing;

-- ============================================================
-- O RECALCULO PASSA A REGISTRAR A PASSADA
--
-- A funcao e a MESMA de D-199 -- convergencia por `is distinct from`, tres
-- graos, uma instrucao so -- e ganha um upsert de UMA linha no fim. O corpo
-- inteiro esta repetido aqui porque `create or replace` exige o corpo
-- inteiro; a unica diferenca em relacao a 20260902115548 esta depois do
-- `select ... into v_affected`.
-- ============================================================

create or replace function private.refresh_daily_sales_metrics(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_date_from date,
  p_date_to date
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_affected integer := 0;
begin
  if p_organization_id is null
     or p_ml_account_id is null
     or p_date_from is null
     or p_date_to is null
     or p_date_from > p_date_to then
    raise exception 'invalid sales metrics refresh range'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_ml_account_id::text, 0)
  );

  if not exists (
    select 1
    from public.ml_accounts a
    where a.id = p_ml_account_id
      and a.organization_id = p_organization_id
  ) then
    raise exception 'ml account does not belong to organization'
      using errcode = '22023';
  end if;

  with computed as materialized (
    select *
    from private.compute_daily_sales_metrics(
      p_organization_id,
      p_date_from,
      p_date_to,
      p_ml_account_id
    )
  ),
  gravado_listing as (
    insert into public.daily_listing_metrics (
      organization_id,
      ml_account_id,
      mlb_id,
      variation_id,
      metric_date,
      units_sold,
      gross_revenue,
      orders_count,
      purchases_count
    )
    select
      metrics.organization_id,
      metrics.ml_account_id,
      metrics.mlb_id,
      metrics.variation_id,
      metrics.metric_date,
      metrics.units_sold,
      metrics.gross_revenue,
      metrics.orders_count,
      metrics.purchases_count
    from computed metrics
    where metrics.metric_grain = 'listing'
    on conflict (ml_account_id, mlb_id, variation_id, metric_date) do update
      set units_sold      = excluded.units_sold,
          gross_revenue   = excluded.gross_revenue,
          orders_count    = excluded.orders_count,
          purchases_count = excluded.purchases_count
      where (public.daily_listing_metrics.units_sold,
             public.daily_listing_metrics.gross_revenue,
             public.daily_listing_metrics.orders_count,
             public.daily_listing_metrics.purchases_count)
            is distinct from
            (excluded.units_sold,
             excluded.gross_revenue,
             excluded.orders_count,
             excluded.purchases_count)
    returning 1
  ),
  removido_listing as (
    delete from public.daily_listing_metrics d
    where d.organization_id = p_organization_id
      and d.ml_account_id = p_ml_account_id
      and d.metric_date between p_date_from and p_date_to
      and not exists (
        select 1
        from computed c
        where c.metric_grain = 'listing'
          and c.mlb_id = d.mlb_id
          and c.variation_id is not distinct from d.variation_id
          and c.metric_date = d.metric_date
      )
    returning 1
  ),
  gravado_sku as (
    insert into public.daily_sku_metrics (
      organization_id,
      ml_account_id,
      sku_id,
      metric_date,
      units_sold,
      gross_revenue,
      orders_count,
      purchases_count
    )
    select
      metrics.organization_id,
      metrics.ml_account_id,
      metrics.sku_id,
      metrics.metric_date,
      metrics.units_sold,
      metrics.gross_revenue,
      metrics.orders_count,
      metrics.purchases_count
    from computed metrics
    where metrics.metric_grain = 'sku'
    on conflict (ml_account_id, sku_id, metric_date) do update
      set units_sold      = excluded.units_sold,
          gross_revenue   = excluded.gross_revenue,
          orders_count    = excluded.orders_count,
          purchases_count = excluded.purchases_count
      where (public.daily_sku_metrics.units_sold,
             public.daily_sku_metrics.gross_revenue,
             public.daily_sku_metrics.orders_count,
             public.daily_sku_metrics.purchases_count)
            is distinct from
            (excluded.units_sold,
             excluded.gross_revenue,
             excluded.orders_count,
             excluded.purchases_count)
    returning 1
  ),
  removido_sku as (
    delete from public.daily_sku_metrics d
    where d.organization_id = p_organization_id
      and d.ml_account_id = p_ml_account_id
      and d.metric_date between p_date_from and p_date_to
      and not exists (
        select 1
        from computed c
        where c.metric_grain = 'sku'
          and c.sku_id = d.sku_id
          and c.metric_date = d.metric_date
      )
    returning 1
  ),
  gravado_account as (
    insert into public.daily_account_metrics (
      organization_id,
      ml_account_id,
      metric_date,
      units_sold,
      gross_revenue,
      orders_count,
      purchases_count
    )
    select
      metrics.organization_id,
      metrics.ml_account_id,
      metrics.metric_date,
      metrics.units_sold,
      metrics.gross_revenue,
      metrics.orders_count,
      metrics.purchases_count
    from computed metrics
    where metrics.metric_grain = 'account'
    on conflict (ml_account_id, metric_date) do update
      set units_sold      = excluded.units_sold,
          gross_revenue   = excluded.gross_revenue,
          orders_count    = excluded.orders_count,
          purchases_count = excluded.purchases_count
      where (public.daily_account_metrics.units_sold,
             public.daily_account_metrics.gross_revenue,
             public.daily_account_metrics.orders_count,
             public.daily_account_metrics.purchases_count)
            is distinct from
            (excluded.units_sold,
             excluded.gross_revenue,
             excluded.orders_count,
             excluded.purchases_count)
    returning 1
  ),
  removido_account as (
    delete from public.daily_account_metrics d
    where d.organization_id = p_organization_id
      and d.ml_account_id = p_ml_account_id
      and d.metric_date between p_date_from and p_date_to
      and not exists (
        select 1
        from computed c
        where c.metric_grain = 'account'
          and c.metric_date = d.metric_date
      )
    returning 1
  )
  select
    (select count(*) from gravado_listing)
    + (select count(*) from removido_listing)
    + (select count(*) from gravado_sku)
    + (select count(*) from removido_sku)
    + (select count(*) from gravado_account)
    + (select count(*) from removido_account)
  into v_affected;

  /*
    A PASSADA FICA REGISTRADA, tenha ela escrito ou não.

    Uma linha por conta, no fim da mesma transação que escreveu (ou não) as
    métricas: se o recálculo abortar, o carimbo não anda — e essa é a
    propriedade que faz o selo poder ser acreditado.
  */
  insert into public.metric_refresh_state as estado (
    ml_account_id,
    organization_id,
    last_refresh_at,
    last_change_at,
    last_rows_written
  )
  values (
    p_ml_account_id,
    p_organization_id,
    pg_catalog.now(),
    case when v_affected > 0 then pg_catalog.now() else null end,
    v_affected
  )
  on conflict (ml_account_id) do update
    set last_refresh_at   = pg_catalog.now(),
        last_change_at    = case when v_affected > 0 then pg_catalog.now() else estado.last_change_at end,
        last_rows_written = v_affected;

  return v_affected;
end;
$function$;

comment on function private.refresh_daily_sales_metrics(uuid, uuid, date, date) is
  'Converge atomicamente os tres graos L3 de uma conta no intervalo informado. Desde D-199 escreve SO o que difere: linha igual nao vira UPDATE, nao gera WAL e nao deixa tupla morta. O retorno e "linhas efetivamente escritas" (inseridas + atualizadas + removidas) -- um recompute que nao muda nada reporta 0, e isso e a verdade. Desde D-304 registra a passada em metric_refresh_state, uma linha por conta, para separar "o numero mudou" de "o numero foi conferido".';

revoke all on function private.refresh_daily_sales_metrics(uuid, uuid, date, date)
  from public, anon, authenticated, service_role;
grant execute on function private.refresh_daily_sales_metrics(uuid, uuid, date, date)
  to service_role;

-- ============================================================
-- AS LEITURAS PASSAM A DEVOLVER O CARIMBO NOVO
--
-- `last_computed_at` NÃO SAI e não muda de sentido: ele continua sendo o
-- maior `computed_at` das linhas do recorte, e continua NULO quando não há
-- linha nenhuma -- contrato que a Home usa para distinguir "nunca calculado"
-- de "calculado e deu zero". O que entra ao lado dele é `last_refreshed_at`,
-- a resposta para a outra pergunta.
--
-- O valor é o MENOR `last_refresh_at` entre as contas do recorte: numa tela
-- que soma quatro contas, o frescor honesto é o do elo mais fraco. A RLS de
-- `metric_refresh_state` já restringe a subconsulta ao que o usuário alcança
-- (`security invoker`, como as demais).
-- ============================================================

-- A ASSINATURA VIVA É A DE CINCO PARÂMETROS (D-237): aquela fatia derrubou a
-- de três e criou esta com defaults. Recriar a de três aqui criaria ambiguidade
-- na chamada com três argumentos nomeados -- o PostgREST recusaria as duas.
drop function public.get_sales_summary(date, date, uuid, text, boolean);

create function public.get_sales_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  average_ticket numeric,
  average_selling_price numeric,
  last_computed_at timestamptz,
  last_refreshed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    -- Ramo SEM recorte de marca: a fonte de sempre, plano identico ao de antes.
    select m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count, m.computed_at
    from public.daily_account_metrics m
    where p_supplier_brand is null and not p_sem_marca
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)

    union all

    -- Ramo COM recorte: grao fino, que e o unico que conhece SKU e marca.
    select m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count, m.computed_at
    from public.daily_sku_metrics m
    where (p_supplier_brand is not null or p_sem_marca)
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (
        case when p_sem_marca
          then m.sku_id is null
               or not exists (select 1 from public.skus s
                              where s.id = m.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s
                       where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
  )
  select
    coalesce(sum(e.units_sold), 0)::bigint as units_sold,
    coalesce(round(sum(e.gross_revenue), 2), 0) as gross_revenue,
    coalesce(sum(e.orders_count), 0)::bigint as orders_count,
    -- NULL com recorte (D-237): somar contagem distinta entre graos conta o
    -- mesmo pack duas vezes.
    case when p_supplier_brand is null and not p_sem_marca
         then coalesce(sum(e.purchases_count), 0)::bigint end as purchases_count,
    case when p_supplier_brand is null and not p_sem_marca
         then round(sum(e.gross_revenue) / nullif(sum(e.purchases_count), 0), 2) end as average_ticket,
    round(sum(e.gross_revenue) / nullif(sum(e.units_sold), 0), 2) as average_selling_price,
    max(e.computed_at) as last_computed_at,
    -- O elo mais fraco entre as contas do recorte. A RLS de
    -- `metric_refresh_state` ja restringe a subconsulta ao que o usuario
    -- alcanca (`security invoker`, como o resto).
    (
      select min(r.last_refresh_at)
      from public.metric_refresh_state r
      where p_ml_account_id is null or r.ml_account_id = p_ml_account_id
    ) as last_refreshed_at
  from escopo e
$$;

comment on function public.get_sales_summary(date, date, uuid, text, boolean) is
  'Resumo de vendas do periodo (Fase 5A; marca desde D-237). SEM recorte de marca le daily_account_metrics; COM recorte troca para daily_sku_metrics -- as duas reconciliam. purchases_count e average_ticket voltam NULL sob recorte de proposito. Desde D-304 devolve tambem last_refreshed_at: quando o recalculo PASSOU por ultimo, que e diferente de quando o numero mudou (last_computed_at). security invoker.';

revoke all on function public.get_sales_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_summary(date, date, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- O lado "processado por nos" da Saude da Sincronizacao (D-143)
-- ------------------------------------------------------------

drop function if exists public.get_processing_health(uuid);

create function public.get_processing_health(p_organization_id uuid)
returns table (
  ml_account_id uuid,
  account_label text,
  latest_metric_date date,
  last_computed_at timestamptz,
  last_refreshed_at timestamptz,
  last_rows_written integer
)
language sql stable security invoker set search_path = ''
as $$
  -- O lado "processado por NOS" (PRD: distinguir dado puxado do ML de dado
  -- recalculado) -- e onde os gargalos aparecem: o ML pode estar em dia e o
  -- recalculo de metricas parado.
  --
  -- Desde D-304 a linha mostra as DUAS datas. Elas divergirem e o estado
  -- SAUDAVEL de um dia sem venda; a segunda parar e que e defeito.
  select m.ml_account_id, a.label,
         max(m.metric_date)  as latest_metric_date,
         max(m.computed_at)  as last_computed_at,
         max(e.last_refresh_at) as last_refreshed_at,
         max(e.last_rows_written) as last_rows_written
  from public.daily_account_metrics m
  join public.ml_accounts a on a.id = m.ml_account_id
  left join public.metric_refresh_state e on e.ml_account_id = m.ml_account_id
  where m.organization_id = p_organization_id
  group by 1,2
  order by a.label
$$;

comment on function public.get_processing_health(uuid) is
  'O lado processado da sincronizacao (D-143): ate que dia as metricas foram calculadas, quando o numero mudou pela ultima vez e quando o recalculo passou por ultimo (D-304). Complementa get_sync_health -- o ML pode estar em dia e o recalculo parado.';

revoke all on function public.get_processing_health(uuid) from public, anon;
grant execute on function public.get_processing_health(uuid) to authenticated, service_role;
