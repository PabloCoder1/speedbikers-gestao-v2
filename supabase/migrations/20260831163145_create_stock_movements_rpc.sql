-- ============================================================
-- Movimentações de estoque (D-167) — o primeiro item da trilha 5E
-- ("experiência sobre dados prontos"): tornar o ledger utilizável para
-- responder "por que o saldo mudou?". Leitura pura — o ledger continua
-- append-only e intocável pela interface.
--
-- O EXPLAIN reprovou a 1ª versão (685 ms): `count(*) over ()` materializava
-- as 225k linhas COM join e derramava em temp. O desenho aprovado separa
-- página (por índice novo, ~4 ms) de contagem (sem join, sobre o conjunto
-- filtrado) — o join com skus/profiles acontece só nas linhas da página.
-- (O corpo desta função é substituído na migration seguinte, medida antes
-- de qualquer tela consumir — a CTE dupla ainda materializava.)
-- ============================================================

-- Extrato da organização, mais recente primeiro — o índice que faltava
-- (os existentes cobrem extrato POR SKU e busca por origem).
create index stock_movements_org_timeline_idx
  on public.stock_movements (organization_id, occurred_at desc, id desc);

create function public.get_stock_movements(
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
  with filtered as (
    select m.id, m.occurred_at, m.movement_type, m.location_kind, m.qty_delta,
           m.sku_id, m.source_type, m.source_id, m.reason, m.created_by
    from public.stock_movements m
    where m.organization_id = p_organization_id
      and (p_movement_type is null or m.movement_type = p_movement_type)
      and (p_location_kind is null or m.location_kind = p_location_kind)
      and (p_source_type is null or m.source_type = p_source_type)
      -- Dia civil America/Sao_Paulo, como todas as janelas do projeto.
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
  ),
  page as (
    select * from filtered
    order by occurred_at desc, id desc
    limit greatest(least(p_limit, 200), 1)
    offset greatest(p_offset, 0)
  ),
  total as (
    select count(*) as n from filtered
  )
  select page.id, page.occurred_at, page.movement_type, page.location_kind,
         page.qty_delta, page.sku_id, s.sku, s.title as sku_title,
         page.source_type, page.source_id, page.reason,
         p.full_name as created_by_name,
         total.n::bigint as total_count
  from page
  join public.skus s on s.id = page.sku_id
  left join public.profiles p on p.id = page.created_by
  cross join total
  order by page.occurred_at desc, page.id desc
$$;

comment on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) is
  'Extrato paginado do ledger (D-167, trilha 5E): filtros por SKU/tipo/local/origem/período, contagem sobre o conjunto filtrado, contexto humano (SKU + ator + motivo). security invoker: RLS filtra antes. Leitura pura — o ledger segue append-only.';

revoke all on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) from public, anon;
grant execute on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) to authenticated, service_role;
