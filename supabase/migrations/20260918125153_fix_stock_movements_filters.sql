-- A busca do extrato agora aceita tambem a referencia externa EXATA que o
-- usuario normalmente cola (pedido, documento, reclamacao ou compra). O
-- indice existente `(organization_id, source_type, source_id)` continua sendo
-- util quando a origem esta filtrada; sem origem, a medicao no Dev (240.653
-- linhas) ficou em 79 ms, abaixo do orcamento de 2 s da tela e sem justificar
-- outro indice pago em toda escrita do ledger.
--
-- A faixa de KPIs tinha uma semantica de periodo diferente da tabela: recebia
-- `timestamptz` e tratava `ate` como limite exclusivo, enquanto o ledger trata
-- as datas como dias civis inclusivos de America/Sao_Paulo. Mantemos a
-- assinatura (evita overload no PostgREST e preserva consumidores), mas
-- convertemos os parametros vindos da UI para o mesmo intervalo do ledger.

create or replace function public.get_stock_movements(
  p_organization_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_search text default null,
  p_movement_type text default null,
  p_location_kind text default null,
  p_source_type text default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  id uuid,
  occurred_at timestamptz,
  movement_type text,
  location_kind text,
  qty_delta numeric,
  sku_id uuid,
  sku text,
  sku_title text,
  source_type text,
  source_id text,
  reason text,
  created_by_name text,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select page.id, page.occurred_at, page.movement_type, page.location_kind,
         page.qty_delta, page.sku_id, s.sku, s.title as sku_title,
         page.source_type, page.source_id, page.reason,
         p.full_name as created_by_name,
         (
           select count(*)
           from public.stock_movements m2
           where m2.organization_id = p_organization_id
             and (p_movement_type is null or m2.movement_type = p_movement_type)
             and (p_location_kind is null or m2.location_kind = p_location_kind)
             and (p_source_type is null or m2.source_type = p_source_type)
             and (p_date_from is null or m2.occurred_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo'))
             and (p_date_to is null or m2.occurred_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo'))
             and (
               p_search is null
               or m2.source_id = p_search
               or m2.sku_id in (
                 select k.id from public.skus k
                 where k.organization_id = p_organization_id
                   and (k.sku ilike '%' || p_search || '%' or k.title ilike '%' || p_search || '%')
               )
             )
         )::bigint as total_count
  from (
    select m.id, m.occurred_at, m.movement_type, m.location_kind, m.qty_delta,
           m.sku_id, m.source_type, m.source_id, m.reason, m.created_by
    from public.stock_movements m
    where m.organization_id = p_organization_id
      and (p_movement_type is null or m.movement_type = p_movement_type)
      and (p_location_kind is null or m.location_kind = p_location_kind)
      and (p_source_type is null or m.source_type = p_source_type)
      and (p_date_from is null or m.occurred_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo'))
      and (p_date_to is null or m.occurred_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo'))
      and (
        p_search is null
        or m.source_id = p_search
        or m.sku_id in (
          select k.id from public.skus k
          where k.organization_id = p_organization_id
            and (k.sku ilike '%' || p_search || '%' or k.title ilike '%' || p_search || '%')
        )
      )
    order by m.occurred_at desc, m.id desc
    limit greatest(least(p_limit, 200), 1)
    offset greatest(p_offset, 0)
  ) page
  join public.skus s on s.id = page.sku_id
  left join public.profiles p on p.id = page.created_by
  order by page.occurred_at desc, page.id desc
$$;

comment on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) is
  'Extrato paginado do ledger para /estoque/movimentacoes. Busca por SKU/titulo ou referencia externa exata; periodo usa dias civis inclusivos de America/Sao_Paulo. Security invoker e RLS preservadas.';

revoke all on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) from public, anon;
grant execute on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) to authenticated, service_role;

create or replace function public.get_stock_movements_summary(
  p_organization_id uuid,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_movement_type text default null,
  p_location_kind text default null,
  p_source_type text default null,
  p_search text default null
)
returns table (
  movimentacoes bigint,
  entradas bigint,
  saidas bigint,
  skus_tocados bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*)::bigint as movimentacoes,
    count(*) filter (where m.qty_delta > 0)::bigint as entradas,
    count(*) filter (where m.qty_delta < 0)::bigint as saidas,
    count(distinct m.sku_id)::bigint as skus_tocados
  from public.stock_movements m
  join public.skus sk on sk.id = m.sku_id
  where m.organization_id = p_organization_id
    and (
      p_date_from is null
      or m.occurred_at >= (((p_date_from at time zone 'UTC')::date)::timestamp at time zone 'America/Sao_Paulo')
    )
    and (
      p_date_to is null
      or m.occurred_at < (((p_date_to at time zone 'UTC')::date + 1)::timestamp at time zone 'America/Sao_Paulo')
    )
    and (p_movement_type is null or m.movement_type = p_movement_type)
    and (p_location_kind is null or m.location_kind = p_location_kind)
    and (p_source_type is null or m.source_type = p_source_type)
    and (
      p_search is null
      or m.source_id = p_search
      or sk.sku ilike '%' || p_search || '%'
      or sk.title ilike '%' || p_search || '%'
    )
$$;

comment on function public.get_stock_movements_summary(uuid, timestamptz, timestamptz, text, text, text, text) is
  'KPIs de /estoque/movimentacoes. Conta linhas (nunca soma unidades), usa o sinal do delta, replica os filtros da tabela, aceita referencia externa exata e interpreta o periodo como dias civis inclusivos de America/Sao_Paulo. Security invoker.';

revoke all on function public.get_stock_movements_summary(uuid, timestamptz, timestamptz, text, text, text, text) from public, anon;
grant execute on function public.get_stock_movements_summary(uuid, timestamptz, timestamptz, text, text, text, text) to authenticated, service_role;
