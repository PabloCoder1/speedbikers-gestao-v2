-- Curva ABC com escopo, criterio e janela (D-140).
--
-- DUAS COISAS, e a segunda foi achada implementando a primeira.
--
-- 1. ESCOPO E CRITERIO (o item da Fase 5C)
--
-- A curva era global e por faturamento, sem parametro nenhum. O requisito pede
-- RECALCULO dentro do escopo de conta, nao uma curva global filtrada -- e a
-- diferenca nao e teorica. Medido em 2026-08-29: 743 SKUs vendem em mais de
-- uma conta e 476 deles (64,1%) mudam de classe conforme a conta. O
-- `docs/PRODUCT_REQUIREMENTS.md` media 726/450/62% em 28/08: o fenomeno e
-- estavel.
--
-- Por isso `p_ml_account_id` entra nas DUAS pontas: no conjunto (quais SKUs) e
-- no denominador (`total`). Filtrar so o conjunto manteria o denominador
-- global e produziria percentuais que nao somam 100 dentro do escopo.
--
-- Prova de que recalcula em vez de filtrar: a curva global tem 1.492 SKUs e
-- 270 na classe A; escopada numa conta tem 541 SKUs, 126 na classe A, e 189
-- deles MUDAM de classe. Se fosse filtro, a classe seria identica. Trocar o
-- criterio de faturamento para unidades muda outros 312.
--
-- 2. A TELA MOSTRAVA 1.000 DE 1.492 -- SETIMA ocorrencia da classe de D-131
--
-- `apps/web/app/curva-abc/page.tsx` chamava a RPC sem `.range()`, contra o
-- teto `max_rows = 1000`. Aqui o estrago passou de "lista incompleta" para
-- ESTATISTICA ERRADA, porque a tela somava as classes em JavaScript sobre o
-- array truncado:
--
--   classe C real: 790   -- a tela exibia 298 (62% invisiveis)
--   "sem Full" real: 1.180 -- a tela via 699 (41% invisiveis)
--
-- O filtro "sem Full" tambem rodava em JavaScript sobre o resultado truncado,
-- num filtro cujo proposito inteiro e achar SKUs que dependem so de estoque
-- local. Entre os que ele escondia havia itens de classe A.
--
-- Correcao: filtro e paginacao no Postgres, e as CONTAGENS DE CLASSE viram
-- janela sobre o conjunto filtrado INTEIRO (`count(*) filter (...) over ()`),
-- nunca sobre a pagina. Conferido: 1.492 / A=270 / B=432 / C=790 sem filtro, e
-- 1.180 / A=99 / B=317 / C=764 com "sem Full" -- os mesmos numeros da medicao
-- direta. Os 99 de classe A sem Full nenhum sao exatamente o que o filtro
-- existe para revelar, e eram justamente o que estava truncado.
--
-- `EXPLAIN (ANALYZE, BUFFERS)`: 102 ms, 7.871 buffers na curva global inteira.
-- Nenhum indice novo -- o plano nao pediu.
--
-- A classe continua decidida pelo acumulado ANTES de somar o proprio SKU: sem
-- isso um item dominante cairia em C por seu proprio acumulado passar de 95%.

drop function public.get_sku_abc_curve(uuid, date, date);

create function public.get_sku_abc_curve(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_criterion text default 'faturamento',
  p_only_without_full boolean default false,
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  sku_id uuid, sku text, title text, metric_value numeric, metric_share numeric,
  cumulative_share numeric, abc_class text, full_quantity numeric,
  total_count bigint, class_a_count bigint, class_b_count bigint, class_c_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  with base as (
    select m.sku_id,
      case p_criterion
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos'  then sum(m.orders_count)::numeric
        else sum(m.gross_revenue)
      end as metric_value
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
      -- Escopo na PONTA 1: quais SKUs entram na curva.
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
    group by m.sku_id
    having case p_criterion
             when 'unidades' then sum(m.units_sold)::numeric
             when 'pedidos'  then sum(m.orders_count)::numeric
             else sum(m.gross_revenue)
           end > 0
  ),
  -- Escopo na PONTA 2: o denominador sai do MESMO conjunto escopado. Um
  -- denominador global com conjunto filtrado daria percentuais que nao somam
  -- 100 dentro do escopo -- o defeito que "filtrar a curva global" produz.
  total as (select sum(metric_value) as total_value from base),
  ranked as (
    select b.sku_id, b.metric_value,
      round(b.metric_value / nullif(t.total_value,0) * 100, 2) as metric_share,
      round(sum(b.metric_value) over w / nullif(t.total_value,0) * 100, 2) as cumulative_share,
      round((sum(b.metric_value) over w - b.metric_value) / nullif(t.total_value,0) * 100, 2)
        as cumulative_share_before
    from base b cross join total t
    window w as (order by b.metric_value desc, b.sku_id)
  ),
  latest_full as (
    select distinct on (f.sku_id, f.ml_account_id) f.sku_id, f.ml_account_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
    order by f.sku_id, f.ml_account_id, f.captured_at desc
  ),
  full_by_sku as (select sku_id, sum(quantity) as full_quantity from latest_full group by sku_id),
  classificada as (
    select r.sku_id, sk.sku, sk.title, r.metric_value, r.metric_share, r.cumulative_share,
      case when r.cumulative_share_before < 80 then 'A'
           when r.cumulative_share_before < 95 then 'B'
           else 'C' end as abc_class,
      coalesce(fb.full_quantity, 0) as full_quantity
    from ranked r
    join public.skus sk on sk.id = r.sku_id
    left join full_by_sku fb on fb.sku_id = r.sku_id
  ),
  filtrada as (
    -- O filtro "sem Full" saiu do JavaScript e veio para ca: sobre resultado
    -- truncado ele escondia 481 dos 1.180 SKUs, incluindo itens de classe A.
    select * from classificada
    where not p_only_without_full or full_quantity = 0
  )
  select f.sku_id, f.sku, f.title, f.metric_value, f.metric_share, f.cumulative_share,
         f.abc_class, f.full_quantity,
         -- Janela sobre o conjunto FILTRADO INTEIRO, nunca sobre a pagina.
         count(*) over ()                                as total_count,
         count(*) filter (where f.abc_class='A') over () as class_a_count,
         count(*) filter (where f.abc_class='B') over () as class_b_count,
         count(*) filter (where f.abc_class='C') over () as class_c_count
  from filtrada f
  order by f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer) is
  'Curva ABC com ESCOPO, CRITERIO e janela (D-140). O escopo de conta entra nas DUAS pontas -- conjunto e denominador -- para a curva ser RECALCULADA dentro do escopo, nunca uma curva global filtrada: medido em 2026-08-29, 743 SKUs vendem em mais de uma conta e 476 (64,1%) mudam de classe conforme a conta. As contagens de classe sao janela sobre o conjunto FILTRADO INTEIRO, nao sobre a pagina -- a versao anterior as somava em JavaScript sobre um resultado truncado em 1.000 de 1.492 e exibia classe C = 298 quando o real era 790.';

revoke all on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer) from public, anon;
grant execute on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer) to authenticated, service_role;
