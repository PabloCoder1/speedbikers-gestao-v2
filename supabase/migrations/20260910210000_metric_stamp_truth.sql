-- ============================================================
-- TRÊS CORREÇÕES NA FATIA DE D-304, ANTES QUE ELAS VIRASSEM HÁBITO.
--
-- A fatia anterior (`20260910200000`) separou "quando o número mudou" de
-- "quando alguém conferiu" e acertou o selo. Um painel de revisão apontou três
-- defeitos nela, e os três são reais — dois deles da classe que a própria
-- fatia existe para combater: tela dizendo o que o dado não sustenta.
--
-- ------------------------------------------------------------
-- 1. `computed_at` CONTINUAVA SENDO "QUANDO A LINHA NASCEU"
-- ------------------------------------------------------------
--
-- A fatia batizou a coluna de "Última mudança" em `/sincronizacao` e em
-- `/skus/[skuId]` — e ela não era isso. Desde D-199 a linha só é reescrita
-- quando algum valor dela difere; bastava incluir `computed_at` na lista do
-- `do update set` para o carimbo passar a significar exatamente o rótulo. Não
-- incluir era deixar dois rótulos falsos no lugar do que acabara de ser
-- corrigido.
--
-- **Custo: zero linha a mais.** A tupla já está sendo reescrita quando o
-- `where ... is distinct from` deixa passar; a coluna entra de carona.
--
-- **E ela NÃO entra na comparação.** Se `computed_at` fosse para dentro do
-- `is distinct from`, `excluded.computed_at` seria o `now()` do comando e
-- diferiria SEMPRE: toda linha igual voltaria a ser reescrita e as 485 mil
-- escritas/dia de D-199 voltariam em silêncio. A prova no rodapé reprova essa
-- volta pelo catálogo.
--
-- ------------------------------------------------------------
-- 2. UMA CONTA REVOGADA CONGELARIA O SELO PARA SEMPRE
-- ------------------------------------------------------------
--
-- O frescor da tela é o `min(last_refresh_at)` das contas alcançadas — o elo
-- mais fraco, que é o honesto. Só que conta REVOKED **para de ser recalculada
-- de propósito** (a varredura e a reconciliação só enfileiram CONNECTED): o
-- carimbo dela congela, o `min()` gruda naquele instante e o selo fica
-- vermelho para sempre, sem nada de errado acontecendo.
--
-- É o mesmo defeito de origem, com outra fantasia. O `min()` passa a olhar só
-- contas CONNECTED.
--
-- ------------------------------------------------------------
-- 3. CONTA SEM MÉTRICA SUMIA DA SAÚDE DA SINCRONIZAÇÃO
-- ------------------------------------------------------------
--
-- `get_processing_health` partia de `daily_account_metrics`. Conta conectada
-- que ainda não produziu métrica nenhuma — a recém-conectada, justamente a que
-- mais se olha — não aparecia na tabela. Ela passa a partir de `ml_accounts`,
-- e "nunca" vira uma linha visível em vez de uma ausência.
-- ============================================================

-- Privilégio que não existe não pode ser usado por engano: nada nesta casa
-- apaga linha de estado — a remoção vem do `on delete cascade` da conta.
revoke delete on public.metric_refresh_state from service_role;

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
          purchases_count = excluded.purchases_count,
          -- O carimbo entra na ESCRITA, nunca na comparação abaixo.
          computed_at     = pg_catalog.now()
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
          purchases_count = excluded.purchases_count,
          computed_at     = pg_catalog.now()
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
          purchases_count = excluded.purchases_count,
          computed_at     = pg_catalog.now()
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
  'Converge atomicamente os tres graos L3 de uma conta no intervalo informado. Desde D-199 escreve SO o que difere -- linha igual nao vira UPDATE, nao gera WAL e nao deixa tupla morta -- e o retorno e "linhas efetivamente escritas". Desde D-304 registra a passada em metric_refresh_state (uma linha por conta) e carimba computed_at na linha que MUDA, para que "ultima mudanca" e "ultima conferencia" sejam duas datas de verdade.';

revoke all on function private.refresh_daily_sales_metrics(uuid, uuid, date, date)
  from public, anon, authenticated, service_role;
grant execute on function private.refresh_daily_sales_metrics(uuid, uuid, date, date)
  to service_role;

-- ------------------------------------------------------------
-- O elo mais fraco passa a olhar só o que É recalculado
-- ------------------------------------------------------------

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
    select m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count, m.computed_at
    from public.daily_account_metrics m
    where p_supplier_brand is null and not p_sem_marca
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)

    union all

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
    case when p_supplier_brand is null and not p_sem_marca
         then coalesce(sum(e.purchases_count), 0)::bigint end as purchases_count,
    case when p_supplier_brand is null and not p_sem_marca
         then round(sum(e.gross_revenue) / nullif(sum(e.purchases_count), 0), 2) end as average_ticket,
    round(sum(e.gross_revenue) / nullif(sum(e.units_sold), 0), 2) as average_selling_price,
    max(e.computed_at) as last_computed_at,
    /*
      O ELO MAIS FRACO ENTRE AS CONTAS QUE AINDA SÃO RECALCULADAS. Conta
      REVOKED sai da conta de propósito: ela para de ser recalculada por
      decisão, e mantê-la aqui congelaria o selo da organização inteira no
      instante em que ela foi desconectada — o mesmo defeito que esta fatia
      existe para consertar, com outra fantasia.
    */
    (
      select min(r.last_refresh_at)
      from public.metric_refresh_state r
      join public.ml_accounts a on a.id = r.ml_account_id
      where a.status = 'CONNECTED'
        and (p_ml_account_id is null or r.ml_account_id = p_ml_account_id)
    ) as last_refreshed_at
  from escopo e
$$;

comment on function public.get_sales_summary(date, date, uuid, text, boolean) is
  'Resumo de vendas do periodo (Fase 5A; marca desde D-237). SEM recorte de marca le daily_account_metrics; COM recorte troca para daily_sku_metrics. purchases_count e average_ticket voltam NULL sob recorte de proposito. Desde D-304 devolve last_refreshed_at -- quando o recalculo PASSOU por ultimo, o elo mais fraco entre as contas CONNECTED alcancadas. security invoker.';

revoke all on function public.get_sales_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_summary(date, date, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- A conta recém-conectada aparece, mesmo sem métrica nenhuma
-- ------------------------------------------------------------

drop function public.get_processing_health(uuid);

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
  -- Parte das CONTAS, não das métricas: conta conectada que ainda não produziu
  -- métrica nenhuma é justamente a que mais se olha, e ela sumia da tabela.
  -- "Nunca" precisa ser uma linha visível, não uma ausência.
  select a.id,
         a.label,
         (select max(m.metric_date) from public.daily_account_metrics m where m.ml_account_id = a.id),
         (select max(m.computed_at) from public.daily_account_metrics m where m.ml_account_id = a.id),
         e.last_refresh_at,
         e.last_rows_written
  from public.ml_accounts a
  left join public.metric_refresh_state e on e.ml_account_id = a.id
  where a.organization_id = p_organization_id
  order by a.label
$$;

comment on function public.get_processing_health(uuid) is
  'O lado processado da sincronizacao (D-143): ate que dia as metricas foram calculadas, quando o numero mudou e quando o recalculo passou por ultimo (D-304). Parte de ml_accounts para que conta sem metrica apareca como "nunca" em vez de sumir. Complementa get_sync_health.';

revoke all on function public.get_processing_health(uuid) from public, anon;
grant execute on function public.get_processing_health(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- A prova, reemitida
--
-- As guardas de catálogo de D-199 valiam para a função DAQUELA migration.
-- Reemitir a função sem reemitir as guardas deixaria a fatia seguinte livre
-- para desfazê-las sem quebrar teste nenhum — que é exatamente o buraco por
-- onde `computed_at` se perdeu.
-- ------------------------------------------------------------
do $$
declare
  v_fonte text;
begin
  select pg_get_functiondef(p.oid) into v_fonte
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'refresh_daily_sales_metrics';

  if (length(v_fonte) - length(replace(v_fonte, 'is distinct from', ''))) / length('is distinct from') < 3 then
    raise exception 'D-199: os tres upserts precisam do guarda `is distinct from`; sem ele a linha igual volta a ser reescrita';
  end if;

  if position('as materialized' in v_fonte) = 0 then
    raise exception 'D-199: o CTE `computed` precisa continuar `as materialized`';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'refresh_daily_sales_metrics' and p.prosecdef
  ) then
    raise exception 'D-199: refresh_daily_sales_metrics nao pode ser SECURITY DEFINER';
  end if;

  -- NOVA (D-304): o carimbo escreve, e NÃO compara. `excluded.computed_at`
  -- dentro do `is distinct from` faria toda linha igual voltar a ser
  -- reescrita — as 485 mil/dia de volta, sem quebrar teste nenhum.
  if (length(v_fonte) - length(replace(v_fonte, 'computed_at     = pg_catalog.now()', ''))) / length('computed_at     = pg_catalog.now()') < 3 then
    raise exception 'D-304: os tres upserts precisam carimbar computed_at na linha que muda';
  end if;

  if position('excluded.computed_at' in v_fonte) > 0 then
    raise exception 'D-304: computed_at nao pode entrar na comparacao do upsert -- ele difere sempre e desfaz D-199';
  end if;

  -- E o registro da passada continua acontecendo na MESMA transacao.
  if position('metric_refresh_state' in v_fonte) = 0 then
    raise exception 'D-304: a passada precisa ser registrada em metric_refresh_state';
  end if;
end $$;
