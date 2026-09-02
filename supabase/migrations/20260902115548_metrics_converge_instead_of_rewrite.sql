-- ============================================================
-- As metricas diarias param de ser reescritas inteiras (D-199).
--
-- MEDIDO no Dev em 02/09/2026, janela de 24h:
--
--   escritas em daily_listing_metrics ..... 269.504 (135.271 ins + 134.233 del)
--   escritas em daily_sku_metrics ......... 215.355 (108.114 ins + 107.241 del)
--   soma ................................... 485 mil por dia
--   rotatividade de job_runs, para comparar   43 mil por dia
--
-- As duas tabelas de metricas escrevem ONZE VEZES mais que a tabela de
-- telemetria que ja estava na fila para retencao. E o motivo nao e a
-- frequencia dos recomputes: e a forma deles.
--
-- `private.refresh_daily_sales_metrics` APAGA o intervalo inteiro da conta e
-- REINSERE tudo. Um dia com 355 linhas custa 355 delecoes mais 355 insercoes,
-- toda vez, mesmo quando o que mudou foi um pedido so. Medido no dia
-- 2026-08-24: **355 linhas reescritas por recompute, disparado por 0 a 4
-- pedidos que mudaram naquela hora**. Em algumas horas, zero.
--
-- POR QUE ISSO IMPORTA ALEM DO OBVIO. O maior consumidor de tempo do banco
-- nao e consulta de tela: e o decodificador de WAL do Realtime, com 43,4% do
-- total (78.261 chamadas, 496 s -- D-198). A publicacao esta minima e correta,
-- uma tabela so; o custo dele escala com o volume de WAL do banco INTEIRO, e
-- quem produz esse volume sao estas duas tabelas.
--
-- A CORRECAO NAO E RECOMPUTAR MENOS. A frequencia esta certa: um pedido de
-- 17/08 que muda de status hoje realmente suja as metricas de 17/08, e foi
-- verificado que so 46 de 3.876 pedidos reescritos em 24h nao tinham mudanca
-- real no Mercado Livre. O recompute acontece pelo motivo certo. O que estava
-- errado era escrever 355 linhas para atualizar 2.
--
-- Agora: `insert ... on conflict do update ... where a linha DIFERE`. Linha
-- igual nao vira UPDATE, nao gera WAL, nao gera tupla morta para o vacuum. E
-- um `delete` por anti-join tira o que deixou de existir -- o unico papel que
-- o delete ainda tem.
--
-- ENSAIADO antes de aplicar, contra o Dev, em transacao revertida (o Docker
-- local nao sobe nesta maquina). Dia 2026-08-24, metricas ja corretas:
--
--   forma antiga .... 220 linhas escritas
--   forma nova ...... 0
--
-- E a prova que importa mais, na mesma forma de ensaio: estragando o dia de
-- tres jeitos (uma linha alterada, uma apagada, uma linha fantasma inserida),
-- a forma nova converge para a assinatura md5 EXATA da forma antiga --
-- `e66f5fc4c9b7fddf8eaf577766de939a`, 220 linhas. Mesmo numero, mesma linha,
-- menos escrita.
--
-- SOBRE `processed`. O retorno da funcao muda de significado: era "linhas
-- inseridas" (sempre o dia inteiro) e passa a ser "linhas EFETIVAMENTE
-- escritas" (inseridas + atualizadas + removidas). E um sinal melhor -- um
-- recompute que nao muda nada passa a reportar 0, que e a verdade -- mas e
-- uma mudanca de contrato, e por isso esta dita aqui, nos testes de
-- integracao que a afirmavam, e em docs/METRICS.md.
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

  -- A trava consultiva por conta continua serializando incrementais e
  -- rebuilds. Ela nao ficou menos necessaria: dois upserts concorrentes sobre
  -- o mesmo grao disputariam a constraint do mesmo jeito.
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

  -- Uma unica instrucao e um CTE MATERIALIZED: os seis sub-comandos enxergam
  -- o mesmo snapshot de orders/order_items, mesmo se a sincronizacao estiver
  -- persistindo outro pedido em paralelo.
  --
  -- Os upserts e os deletes sao DISJUNTOS por construcao: o upsert age sobre
  -- as chaves que estao em `computed`, o delete sobre as que nao estao. Por
  -- isso a ordem entre eles dentro da instrucao nao importa, e o fato de cada
  -- sub-comando ver o snapshot de ANTES (e nao o efeito dos outros) e correto
  -- aqui em vez de perigoso.
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
      -- `is distinct from` sobre a linha inteira: sem esta clausula o UPDATE
      -- acontece mesmo com valores identicos, escreve a tupla, gera WAL e
      -- deixa a versao antiga para o vacuum. E o `where` que faz a fatia.
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
          and c.sku_id is not distinct from d.sku_id
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

  return v_affected;
end;
$function$;

comment on function private.refresh_daily_sales_metrics(uuid, uuid, date, date) is
  'Converge atomicamente os tres graos L3 de uma conta no intervalo informado. Desde D-199 escreve SO o que difere: linha igual nao vira UPDATE, nao gera WAL e nao deixa tupla morta. O retorno passou a ser "linhas efetivamente escritas" (inseridas + atualizadas + removidas), nao mais "o dia inteiro" -- um recompute que nao muda nada reporta 0, e isso e a verdade.';

-- ------------------------------------------------------------
-- A prova
-- ------------------------------------------------------------
do $$
declare
  v_fonte text;
begin
  select pg_get_functiondef(p.oid) into v_fonte
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'refresh_daily_sales_metrics';

  -- O `where` do `do update` E a fatia. Uma reescrita futura que o remova
  -- devolve as 485 mil escritas por dia sem quebrar teste nenhum -- por isso
  -- a guarda esta no catalogo, como em D-183.
  if (length(v_fonte) - length(replace(v_fonte, 'is distinct from', ''))) / length('is distinct from') < 3 then
    raise exception 'D-199: os tres upserts precisam do guarda `is distinct from`; sem ele a linha igual volta a ser reescrita';
  end if;

  -- Continua materializado: os seis sub-comandos precisam do MESMO snapshot.
  if position('as materialized' in v_fonte) = 0 then
    raise exception 'D-199: o CTE `computed` precisa continuar `as materialized`';
  end if;

  -- Continua SECURITY INVOKER e fora do alcance do browser.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'refresh_daily_sales_metrics' and p.prosecdef
  ) then
    raise exception 'D-199: refresh_daily_sales_metrics nao pode ser SECURITY DEFINER';
  end if;
end $$;
