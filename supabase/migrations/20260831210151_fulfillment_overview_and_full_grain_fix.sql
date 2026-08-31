-- ============================================================
-- Central Full (D-173, trilha 5E) — e a correcao do GRAO do Full onde ele
-- ja era lido errado.
--
-- O item do ROADMAP pedia "operacao propria de Full, nao apenas uma coluna
-- dispersa". Ao medir para desenhar, o problema apareceu antes da tela: o
-- estoque Full e por BUCKET (`inventory_id`, um por item/variacao), e duas
-- leituras da casa colapsavam por `(sku_id, ml_account_id)`, ficando com UM
-- bucket e descartando os outros.
--
-- MEDIDO no Dev em 2026-08-31, sobre 75.852 capturas:
--   * grao errado: 7.098 unidades;  grao certo: **8.408** (15,6% a mais);
--   * 246 pares conta+SKU tem mais de um bucket (ate 5);
--   * 60 SKUs com quantidade divergente entre os dois graos;
--   * **12 SKUs que a Curva ABC declarava "sem Full" TEM Full** — a fila de
--     trabalho "Curva A sem Full" mandava enviar ao Full item que ja estava
--     la.
--
-- `get_sku_dashboard` sempre esteve certo (`distinct on (ml_account_id,
-- item_id, variation_id)`), e e o precedente que esta migration segue.
--
-- JANELA DE FRESCOR de 3 dias, declarada: "ultimo snapshot" passa a
-- significar "ultimo dos ultimos 3 dias". Duas razoes, uma de verdade e uma
-- de custo. Verdade: bucket que nao e recapturado ha 3 dias NAO esta mais no
-- Full, e carregar o saldo antigo para sempre e afirmar estoque que nao
-- existe (a coleta e diaria e hoje tem zero pares com mais de 24h). Custo:
-- sem a janela o `distinct on` varre a tabela inteira, que cresce ~7.500
-- linhas/dia — EXPLAIN mediu **85.805 buffers / 110 ms** contra **27.270
-- buffers / 24 ms** com a janela, e com a janela o custo para de crescer.
-- Nenhum indice novo: o `fulfillment_stock_snapshots_timeline_idx` existente
-- resolve o acesso por `captured_at`.
-- ============================================================

create function public.get_fulfillment_overview(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  -- 'saudavel' | 'parado' | 'ruptura' | 'ausente' | null (sem filtro)
  p_situation text default null,
  p_search text default null,
  -- Um SKU so: e por aqui que o Dashboard de Anuncio le o Full com o grao
  -- certo, em vez de repetir a consulta na tela.
  p_sku_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  ml_account_id uuid,
  account_label text,
  sku_id uuid,
  sku text,
  sku_title text,
  full_quantity numeric,
  buckets integer,
  captured_at timestamptz,
  local_quantity numeric,
  units_sold bigint,
  situation text,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ultimo_bucket as (
    -- O GRAO: um saldo por bucket do Mercado Livre. Colapsar por SKU aqui
    -- perderia as variacoes (246 pares tem mais de uma).
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.sku_id, f.quantity, f.captured_at
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
      and (p_sku_id is null or f.sku_id = p_sku_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_sku as (
    select b.ml_account_id, b.sku_id,
           sum(b.quantity) as full_quantity,
           count(*)::integer as buckets,
           max(b.captured_at) as captured_at
    from ultimo_bucket b
    group by b.ml_account_id, b.sku_id
  ),
  vendas as (
    select m.ml_account_id, m.sku_id, sum(m.units_sold)::bigint as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
    group by m.ml_account_id, m.sku_id
  ),
  saldo_local as (
    -- Estoque fisico e da ORGANIZACAO, nao da conta (regra do PRD). Vem
    -- junto para responder "da para repor?", e a tela mostra em coluna
    -- separada: somar com o Full seria a "soma cega" que o item veta.
    select b.sku_id, sum(b.quantity) as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id and b.location_kind = 'LOCAL'
    group by b.sku_id
  ),
  base as (
    select f.ml_account_id, a.label as account_label, f.sku_id, s.sku, s.title as sku_title,
           f.full_quantity, f.buckets, f.captured_at,
           coalesce(l.local_quantity, 0) as local_quantity,
           coalesce(v.units_sold, 0)::bigint as units_sold,
           -- Criterios DETERMINISTICOS e visiveis, sem score inventado.
           case
             when f.full_quantity > 0 and coalesce(v.units_sold, 0) > 0 then 'saudavel'
             when f.full_quantity > 0 then 'parado'
             when coalesce(v.units_sold, 0) > 0 then 'ruptura'
             else 'ausente'
           end as situation
    from full_por_sku f
    join public.ml_accounts a on a.id = f.ml_account_id
    join public.skus s on s.id = f.sku_id
    left join vendas v on v.ml_account_id = f.ml_account_id and v.sku_id = f.sku_id
    left join saldo_local l on l.sku_id = f.sku_id
    where p_search is null
       or s.sku ilike '%' || p_search || '%'
       or s.title ilike '%' || p_search || '%'
  ),
  filtrado as (
    select * from base
    where p_situation is null or situation = p_situation
  )
  select f.ml_account_id, f.account_label, f.sku_id, f.sku, f.sku_title,
         f.full_quantity, f.buckets, f.captured_at, f.local_quantity, f.units_sold, f.situation,
         (select count(*) from filtrado) as total_count
  from filtrado f
  order by f.full_quantity desc, f.units_sold desc, f.sku
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer) is
  'Central Full (D-173): saldo no Full por conta+SKU no GRAO CERTO (soma dos buckets inventory_id mais recentes, janela de frescor de 3 dias), com venda da janela, saldo LOCAL da organizacao em coluna separada (nunca somado) e situacao deterministica: saudavel | parado | ruptura | ausente. security invoker.';

revoke all on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer) to authenticated, service_role;

-- ============================================================
-- Curva ABC: o mesmo grao, pelo mesmo motivo.
--
-- So o corpo muda (a assinatura e identica), entao `create or replace`
-- basta. `p_only_without_full` era uma fila de trabalho que mandava enviar
-- ao Full 12 SKUs que ja estavam la.
-- ============================================================

create or replace function public.get_sku_abc_curve(
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
  -- Escopo na PONTA 2: o denominador sai do MESMO conjunto escopado.
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
    -- GRAO CORRIGIDO em D-173: um saldo por BUCKET (`inventory_id`), nao por
    -- (sku, conta). O colapso anterior descartava as variacoes: 12 SKUs
    -- apareciam como "sem Full" tendo Full, e o total ficava 15,6% menor.
    -- Janela de frescor igual a da Central Full: saldo nao recapturado ha 3
    -- dias nao e estoque atual.
    select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
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
    select * from classificada
    where not p_only_without_full or full_quantity = 0
  )
  select f.sku_id, f.sku, f.title, f.metric_value, f.metric_share, f.cumulative_share,
         f.abc_class, f.full_quantity,
         count(*) over ()                                as total_count,
         count(*) filter (where f.abc_class='A') over () as class_a_count,
         count(*) filter (where f.abc_class='B') over () as class_b_count,
         count(*) filter (where f.abc_class='C') over () as class_c_count
  from filtrada f
  order by f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer) is
  'Curva ABC com ESCOPO, CRITERIO e janela (D-140; grao do Full corrigido em D-173). O escopo de conta entra nas DUAS pontas -- conjunto e denominador. `full_quantity` soma os buckets inventory_id mais recentes dentro da janela de frescor de 3 dias: o colapso anterior por (sku, conta) descartava variacoes e fazia 12 SKUs aparecerem como "sem Full" tendo Full. As contagens de classe sao janela sobre o conjunto FILTRADO INTEIRO, nao sobre a pagina.';
