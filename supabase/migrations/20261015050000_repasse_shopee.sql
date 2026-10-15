-- ============================================================
-- D-451 -- Repasse da Shopee (etapa E7c da frente multicanal; contrato C-64).
-- A terceira fonte financeira que faltava (R9): QUANDO e QUANTO a Shopee
-- liberou a loja, pedido a pedido (`v2.payment.get_escrow_list`, conferida
-- na referencia oficial em 14/10/2026).
--
-- - `shopee_escrow_releases`: uma linha por liberacao (loja, pedido,
--   momento), com o valor liquidado como a Shopee manda (`payout_amount`).
--   Valor ausente fica NULO.
-- - O `escrow_amount` do pedido (D-427) e o PREVISTO; a liberacao e o
--   REALIZADO. A diferenca entre os dois, por pedido, e o que a tela de
--   conciliacao mostra -- nada aqui muda o recebido nem o resultado (C-58).
-- - A COBERTURA da leitura (`escrow_releases_read_from` e o marco
--   `escrow_releases_synced_until`): liberacao fora dela e desconhecida. O
--   "a liberar" so olha pedidos criados depois do inicio da leitura -- um
--   pedido anterior pode ter sido liberado antes dela.
-- - O extrato da carteira (`get_wallet_transaction_list`) e o detalhe da
--   renda (`get_income_detail`) ficam para depois do sandbox: o extrato nao
--   tem identificador de transacao e o detalhe da renda se contradiz no
--   formato da resposta.
-- ============================================================

alter table public.shopee_shops
  add column if not exists escrow_releases_read_from timestamptz,
  add column if not exists escrow_releases_synced_until timestamptz;

comment on column public.shopee_shops.escrow_releases_read_from is
  'Inicio da leitura dos repasses da loja (D-451). NULO = nunca lido.';
comment on column public.shopee_shops.escrow_releases_synced_until is
  'Ate onde os repasses da loja foram lidos (D-451); so avanca. Liberacao depois dele ainda nao e conhecida.';

create table public.shopee_escrow_releases (
  shopee_shop_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_sn text not null,
  released_at timestamptz not null,
  -- O valor liquidado, como a Shopee manda (pode ser negativo: escrow cobrado da loja).
  payout_amount numeric(14, 2),
  synced_at timestamptz not null default now(),
  primary key (shopee_shop_id, order_sn, released_at),
  constraint shopee_escrow_releases_loja_da_organizacao
    foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade
);

create index shopee_escrow_releases_org_released_idx on public.shopee_escrow_releases (organization_id, released_at);

comment on table public.shopee_escrow_releases is
  'Repasses da Shopee (D-451): cada liberacao do escrow de um pedido a loja, com o valor liquidado, como v2.payment.get_escrow_list manda.';

alter table public.shopee_escrow_releases enable row level security;

create policy shopee_escrow_releases_select_permitted
  on public.shopee_escrow_releases for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

revoke all on public.shopee_escrow_releases from anon, authenticated;
grant select on public.shopee_escrow_releases to authenticated;
grant all on public.shopee_escrow_releases to service_role;

-- ------------------------------------------------------------
-- A gravacao de uma janela lida: as liberacoes e a cobertura, numa transacao.
-- ------------------------------------------------------------
create or replace function public.shopee_upsert_escrow_releases(
  p_shopee_shop_id uuid,
  p_repasses jsonb,
  p_from timestamptz,
  p_until timestamptz,
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

  if p_repasses is null or jsonb_typeof(p_repasses) <> 'array' then
    raise exception 'p_repasses precisa ser um array';
  end if;

  if p_from is null or p_until is null or p_until < p_from then
    raise exception 'janela invalida: % a %', p_from, p_until;
  end if;

  with entrada as (
    select distinct on (e.order_sn, e.released_at) e.*
    from jsonb_to_recordset(p_repasses) as e (order_sn text, released_at timestamptz, payout_amount numeric)
    -- Liberacao fora da janela pedida nao entra: a cobertura e a da janela.
    where e.order_sn is not null and e.order_sn <> ''
      and e.released_at between p_from and p_until
    order by e.order_sn, e.released_at
  ),
  gravados as (
    insert into public.shopee_escrow_releases as r (shopee_shop_id, organization_id, order_sn, released_at, payout_amount, synced_at)
    select p_shopee_shop_id, v_org, e.order_sn, e.released_at, e.payout_amount, p_synced_at
    from entrada e
    on conflict (shopee_shop_id, order_sn, released_at) do update set
      payout_amount = excluded.payout_amount,
      synced_at = excluded.synced_at
    -- Leitura mais velha que a guardada nao sobrescreve.
    where r.synced_at <= excluded.synced_at
    returning 1
  )
  select count(*)::integer into v_gravados from gravados;

  -- A cobertura so cresce; o marco nunca recua.
  update public.shopee_shops
     set escrow_releases_read_from = least(coalesce(escrow_releases_read_from, p_from), p_from),
         escrow_releases_synced_until = greatest(coalesce(escrow_releases_synced_until, p_until), p_until)
   where id = p_shopee_shop_id;

  return v_gravados;
end;
$$;

comment on function public.shopee_upsert_escrow_releases(uuid, jsonb, timestamptz, timestamptz, timestamptz) is
  'Grava uma janela lida dos repasses de uma loja Shopee (D-451): as liberacoes da janela (a leitura mais nova vale) e a cobertura (so cresce). So o worker (service_role).';

revoke all on function public.shopee_upsert_escrow_releases(uuid, jsonb, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.shopee_upsert_escrow_releases(uuid, jsonb, timestamptz, timestamptz, timestamptz) to service_role;

-- ------------------------------------------------------------
-- O resumo pelo DIA DA LIBERACAO (Sao Paulo): TOTAL (loja live lida) e por loja.
-- ------------------------------------------------------------
create or replace function public.get_shopee_repasse_overview(
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
  -- O periodo inteiro dentro da leitura (o fim, ate 2 h atras)? Senao, os numeros sao so do que foi lido.
  cobertura_completa boolean,
  lido_ate timestamptz,
  liberado numeric,
  pedidos_liberados bigint,
  liberacoes_sem_valor bigint,
  -- O `escrow_amount` dos pedidos liberados, quando o financeiro foi lido.
  previsto numeric,
  pedidos_com_previsto bigint,
  -- Por pedido: todas as liberacoes dele menos o previsto; so pedidos com os dois.
  diferenca numeric,
  pedidos_divergentes bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_inicio timestamptz := p_date_from::timestamp at time zone 'America/Sao_Paulo';
  v_fim timestamptz := (p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo';
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment,
           s.escrow_releases_synced_until as ate,
           s.escrow_releases_read_from is not null as lida,
           (s.escrow_releases_read_from is not null
            and s.escrow_releases_read_from <= v_inicio
            and s.escrow_releases_synced_until >= least(v_fim, now() - interval '2 hours')) as coberta
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  no_periodo as materialized (
    select r.shopee_shop_id, r.order_sn, sum(r.payout_amount) as liberado, count(*) filter (where r.payout_amount is null) as sem_valor
    from public.shopee_escrow_releases r
    where r.organization_id = p_organization_id
      and r.shopee_shop_id in (select l.id from lojas l)
      and r.released_at >= v_inicio and r.released_at < v_fim
    group by r.shopee_shop_id, r.order_sn
  ),
  por_pedido as materialized (
    -- Todas as liberacoes de cada pedido liberado no periodo, contra o previsto.
    select p.shopee_shop_id, p.order_sn, p.liberado, p.sem_valor,
           todas.total, todas.algum_sem_valor,
           case when v.financeiro_lido then v.recebido end as previsto
    from no_periodo p
    join lateral (
      select sum(r.payout_amount) as total, bool_or(r.payout_amount is null) as algum_sem_valor
      from public.shopee_escrow_releases r
      where r.shopee_shop_id = p.shopee_shop_id and r.order_sn = p.order_sn
    ) todas on true
    left join public.shopee_sales_orders v on v.shopee_shop_id = p.shopee_shop_id and v.order_sn = p.order_sn
  ),
  agregado as (
    select pp.shopee_shop_id,
           sum(pp.liberado) as liberado,
           count(*) as pedidos,
           sum(pp.sem_valor) as sem_valor,
           sum(pp.previsto) as previsto,
           count(pp.previsto) as com_previsto,
           sum(pp.total - pp.previsto) filter (where pp.previsto is not null and not pp.algum_sem_valor) as diferenca,
           count(*) filter (where pp.previsto is not null and not pp.algum_sem_valor and abs(pp.total - pp.previsto) >= 0.01) as divergentes
    from por_pedido pp
    group by pp.shopee_shop_id
  ),
  por_loja as (
    select l.id, l.nome, l.environment, l.lida, l.coberta, l.ate,
           -- Loja lida sem repasse no periodo: 0.
           case when l.lida then coalesce(a.liberado, 0) end as liberado,
           case when l.lida then coalesce(a.pedidos, 0) end as pedidos,
           case when l.lida then coalesce(a.sem_valor, 0) end as sem_valor,
           case when l.lida then coalesce(a.previsto, 0) end as previsto,
           case when l.lida then coalesce(a.com_previsto, 0) end as com_previsto,
           case when l.lida then coalesce(a.diferenca, 0) end as diferenca,
           case when l.lida then coalesce(a.divergentes, 0) end as divergentes
    from lojas l
    left join agregado a on a.shopee_shop_id = l.id
  ),
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    bool_and(s.coberta),
    min(s.ate),
    round(sum(s.liberado), 2),
    sum(s.pedidos)::bigint,
    sum(s.sem_valor)::bigint,
    round(sum(s.previsto), 2),
    sum(s.com_previsto)::bigint,
    round(sum(s.diferenca), 2),
    sum(s.divergentes)::bigint
  from somaveis s
  having count(*) > 0

  union all

  -- Por loja. Repasse nunca lido: tudo NULO.
  select
    'CONTA', pl.id, pl.nome, pl.environment,
    case when pl.lida then pl.coberta end,
    pl.ate,
    round(pl.liberado, 2),
    pl.pedidos::bigint,
    pl.sem_valor::bigint,
    round(pl.previsto, 2),
    pl.com_previsto::bigint,
    round(pl.diferenca, 2),
    pl.divergentes::bigint
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_repasse_overview(uuid, date, date, uuid[]) is
  'D-451 (C-64): repasses da Shopee pelo dia da liberacao (Sao Paulo) -- liberado, pedidos, o previsto (escrow_amount) dos mesmos pedidos e a diferenca por pedido; TOTAL so de loja live lida; cobertura_completa diz se o periodo esta na leitura. security invoker.';

revoke all on function public.get_shopee_repasse_overview(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_repasse_overview(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- A serie pelo dia da liberacao (so lojas live; dia sem repasse nao aparece).
-- ------------------------------------------------------------
create or replace function public.get_shopee_repasse_daily(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  dia date,
  liberado numeric,
  pedidos bigint,
  liberacoes_sem_valor bigint
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
    (r.released_at at time zone 'America/Sao_Paulo')::date,
    round(sum(r.payout_amount), 2),
    count(distinct (r.shopee_shop_id, r.order_sn))::bigint,
    count(*) filter (where r.payout_amount is null)::bigint
  from public.shopee_escrow_releases r
  join public.shopee_shops s on s.id = r.shopee_shop_id
  where r.organization_id = p_organization_id
    and s.environment = 'live'
    and (p_account_ids is null or r.shopee_shop_id = any (p_account_ids))
    and r.released_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
    and r.released_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  group by 1
  order by 1;
end;
$$;

comment on function public.get_shopee_repasse_daily(uuid, date, date, uuid[]) is
  'D-451 (C-64): repasses da Shopee por dia da liberacao, so lojas live; a soma dos dias fecha com o liberado do TOTAL de get_shopee_repasse_overview. security invoker.';

revoke all on function public.get_shopee_repasse_daily(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_repasse_daily(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- A lista: cada liberacao do periodo, com o previsto do pedido.
-- ------------------------------------------------------------
create or replace function public.get_shopee_repasses(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null,
  p_order_sn text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  environment text,
  order_sn text,
  released_at timestamptz,
  payout_amount numeric,
  previsto numeric,
  -- Todas as liberacoes do pedido menos o previsto; nula sem os dois.
  diferenca_do_pedido numeric,
  liberacoes_do_pedido bigint,
  order_status text,
  shopee_created_at timestamptz,
  total_count bigint
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

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'p_limit deve ficar entre 1 e 200';
  end if;

  if p_offset is null or p_offset < 0 then
    raise exception 'p_offset invalido';
  end if;

  return query
  with
  filtradas as materialized (
    select r.shopee_shop_id, r.order_sn, r.released_at, r.payout_amount
    from public.shopee_escrow_releases r
    where r.organization_id = p_organization_id
      and (p_account_ids is null or r.shopee_shop_id = any (p_account_ids))
      and (p_order_sn is null or r.order_sn = p_order_sn)
      and r.released_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and r.released_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  pagina as materialized (
    select f.*, count(*) over () as total
    from filtradas f
    order by f.released_at desc, f.order_sn, f.shopee_shop_id
    limit p_limit offset p_offset
  )
  select
    pg.shopee_shop_id,
    coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text),
    s.environment,
    pg.order_sn,
    pg.released_at,
    pg.payout_amount,
    case when v.financeiro_lido then round(v.recebido, 2) end,
    case when v.financeiro_lido and not todas.algum_sem_valor then round(todas.total - v.recebido, 2) end,
    todas.n,
    v.order_status,
    v.shopee_created_at,
    pg.total
  from pagina pg
  join public.shopee_shops s on s.id = pg.shopee_shop_id
  join lateral (
    select sum(r.payout_amount) as total, bool_or(r.payout_amount is null) as algum_sem_valor, count(*) as n
    from public.shopee_escrow_releases r
    where r.shopee_shop_id = pg.shopee_shop_id and r.order_sn = pg.order_sn
  ) todas on true
  left join public.shopee_sales_orders v on v.shopee_shop_id = pg.shopee_shop_id and v.order_sn = pg.order_sn
  order by pg.released_at desc, pg.order_sn, pg.shopee_shop_id;
end;
$$;

comment on function public.get_shopee_repasses(uuid, date, date, uuid[], text, integer, integer) is
  'D-451 (C-64): as liberacoes de repasse da Shopee no periodo (dia de Sao Paulo), com o previsto (escrow_amount) do pedido e a diferenca sobre todas as liberacoes dele; paginada (total_count). security invoker.';

revoke all on function public.get_shopee_repasses(uuid, date, date, uuid[], text, integer, integer) from public, anon;
grant execute on function public.get_shopee_repasses(uuid, date, date, uuid[], text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- O que ainda nao foi liberado, AGORA: TOTAL (loja live lida) e por loja.
-- ------------------------------------------------------------
create or replace function public.get_shopee_repasse_pendente(
  p_organization_id uuid,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  account_id uuid,
  account_name text,
  environment text,
  -- Pedidos validos criados depois do inicio da leitura e ainda sem liberacao lida.
  pedidos bigint,
  -- O `escrow_amount` dos que ja tem o financeiro lido.
  a_liberar numeric,
  pedidos_sem_financeiro bigint,
  pedidos_completos bigint,
  pedidos_com_devolucao bigint,
  mais_antigo timestamptz,
  lido_desde timestamptz,
  lido_ate timestamptz
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
           s.escrow_releases_read_from as desde, s.escrow_releases_synced_until as ate
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  pendentes as materialized (
    select v.shopee_shop_id, v.order_sn, v.order_status, v.shopee_created_at, v.recebido, v.financeiro_lido, v.com_devolucao
    from public.shopee_sales_orders v
    join lojas l on l.id = v.shopee_shop_id
    where v.organization_id = p_organization_id
      and l.desde is not null
      and v.situacao = 'VALIDA'
      -- Um pedido de antes do inicio da leitura pode ter sido liberado antes dela.
      and v.shopee_created_at >= l.desde
      and not exists (
        select 1 from public.shopee_escrow_releases r
        where r.shopee_shop_id = v.shopee_shop_id and r.order_sn = v.order_sn
      )
  ),
  agregado as (
    select p.shopee_shop_id,
           count(*) as pedidos,
           sum(p.recebido) filter (where p.financeiro_lido) as a_liberar,
           count(*) filter (where not p.financeiro_lido) as sem_financeiro,
           count(*) filter (where p.order_status = 'COMPLETED') as completos,
           count(*) filter (where p.com_devolucao) as com_devolucao,
           min(p.shopee_created_at) as mais_antigo
    from pendentes p
    group by p.shopee_shop_id
  ),
  por_loja as (
    select l.id, l.nome, l.environment, l.desde, l.ate,
           l.desde is not null as lida,
           case when l.desde is not null then coalesce(a.pedidos, 0) end as pedidos,
           case when l.desde is not null then coalesce(a.a_liberar, 0) end as a_liberar,
           case when l.desde is not null then coalesce(a.sem_financeiro, 0) end as sem_financeiro,
           case when l.desde is not null then coalesce(a.completos, 0) end as completos,
           case when l.desde is not null then coalesce(a.com_devolucao, 0) end as com_devolucao,
           a.mais_antigo
    from lojas l
    left join agregado a on a.shopee_shop_id = l.id
  ),
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    sum(s.pedidos)::bigint,
    round(sum(s.a_liberar), 2),
    sum(s.sem_financeiro)::bigint,
    sum(s.completos)::bigint,
    sum(s.com_devolucao)::bigint,
    min(s.mais_antigo),
    max(s.desde),
    min(s.ate)
  from somaveis s
  having count(*) > 0

  union all

  select
    'CONTA', pl.id, pl.nome, pl.environment,
    pl.pedidos::bigint,
    round(pl.a_liberar, 2),
    pl.sem_financeiro::bigint,
    pl.completos::bigint,
    pl.com_devolucao::bigint,
    pl.mais_antigo,
    pl.desde,
    pl.ate
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_repasse_pendente(uuid, uuid[]) is
  'D-451 (C-64): o que a Shopee ainda nao liberou, agora -- pedidos validos criados depois do inicio da leitura dos repasses e sem liberacao lida, com o previsto (escrow_amount) dos que tem financeiro; TOTAL so de loja live lida; nunca lida = NULO. security invoker.';

revoke all on function public.get_shopee_repasse_pendente(uuid, uuid[]) from public, anon;
grant execute on function public.get_shopee_repasse_pendente(uuid, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (5W).
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_repasse_liberado', 'Repasse liberado pela Shopee',
   'SUM(shopee_escrow_releases.payout_amount) pelo dia da liberacao',
   'get_shopee_repasse_overview (v2.payment.get_escrow_list)', array['account', 'organization'],
   'O valor liquidado de cada pedido liberado a loja, como a Shopee manda; lojas live com repasse lido.',
   'E o dia em que o dinheiro foi liberado, nao o da venda. Liberacao sem valor fica fora da soma e e contada a parte.',
   'included', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_repasse_diferenca', 'Diferenca entre o repasse e o previsto na Shopee',
   'SUM(todas as liberacoes do pedido - escrow_amount) dos pedidos liberados no periodo',
   'get_shopee_repasse_overview', array['account', 'organization'],
   'Por pedido, so com o valor liberado e o financeiro lidos.',
   'Nao entra no recebido nem no resultado (C-58); e conciliacao.',
   'included', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_a_liberar', 'A liberar pela Shopee',
   'SUM(escrow_amount) dos pedidos validos sem liberacao lida, criados depois do inicio da leitura',
   'get_shopee_repasse_pendente', array['account', 'organization'],
   'Retrato de agora; o previsto so dos pedidos com o financeiro lido (os sem financeiro sao contados).',
   'Pedido criado antes do inicio da leitura fica fora (pode ter sido liberado antes dela).',
   'excluded', 'America/Sao_Paulo', date '2026-10-14');
