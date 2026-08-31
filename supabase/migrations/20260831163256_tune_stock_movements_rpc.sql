-- ============================================================
-- Ajuste de D-167, medido antes de qualquer tela consumir: a CTE `filtered`
-- referenciada DUAS vezes (página + contagem) era materializada — 225k
-- linhas indo a temp a cada carga (210 ms, temp read/written ~2.8k). Página
-- e contagem viram subconsultas INDEPENDENTES com os mesmos filtros: a
-- página sai pelo índice (0,3 ms) e a contagem por index-only scan (~63 ms)
-- — 64 ms totais, zero temp.
-- ============================================================

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
