-- D-424: a Curva ABC detalhada -- mais recortes na tela e o painel do Excel.
--
-- Tres RPCs novas, todas `security invoker` (a RLS de `daily_sku_metrics`,
-- `skus`, `inventory_balances`, `fulfillment_stock_snapshots` e `ml_accounts`
-- decide o que cada um enxerga, D-012). `get_sku_abc_curve` fica como esta:
-- a pagina do SKU continua nela.
--
-- A CLASSE e a mesma conta de `get_sku_abc_curve`: SKU com o valor do criterio
-- maior que zero, ordem decrescente com desempate por `sku_id`, e a classe
-- pelo acumulado ANTES do SKU arredondado em 2 casas (A abaixo de 80, B abaixo
-- de 95, C o resto). Mudar a conta aqui faria a tela e a pagina do SKU
-- discordarem da classe do mesmo produto.

-- ---------------------------------------------------------------------------
-- 1. A analise por SKU: as tres metricas, a classe em cada criterio, o periodo
--    anterior, o estoque e a cobertura -- com recortes antes da curva (conta,
--    marca, categoria, tipo: a curva e RECALCULADA dentro deles) e filtros
--    depois dela (classe, Full, estoque, movimento, busca: a classe continua
--    a da curva inteira).
-- ---------------------------------------------------------------------------
create function public.get_sku_abc_analysis(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  -- O periodo de comparacao. Nulo: sem comparacao (movimento nulo).
  p_prev_from date default null,
  p_prev_to date default null,
  p_ml_account_id uuid default null,
  -- `skus.supplier_brand`, a marca real (D-129/D-235).
  p_supplier_brand text default null,
  -- `skus.brand`, que guarda a CATEGORIA do UpSeller (D-129).
  p_category text default null,
  p_kind text default null,
  p_criterion text default 'faturamento',
  p_abc_class text default null,
  p_only_without_full boolean default false,
  -- 'sem_local' | 'sem_estoque' | 'com_estoque'
  p_stock text default null,
  -- 'subiu' | 'caiu' | 'manteve' | 'novo'
  p_movement text default null,
  p_search text default null,
  -- 'curva' | 'faturamento' | 'unidades' | 'pedidos' | 'crescimento' | 'queda'
  -- | 'estoque' | 'cobertura' | 'nome'
  p_order text default 'curva',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  sku_id uuid, sku text, title text, supplier_brand text, category text, kind text, purchase_cost numeric,
  revenue numeric, units numeric, orders numeric,
  metric_value numeric, metric_share numeric, cumulative_share numeric, abc_class text,
  class_revenue text, class_units text, class_orders text,
  prev_metric_value numeric, prev_abc_class text, movement text,
  local_stock numeric, full_stock numeric, coverage_days numeric,
  -- Janelas sobre o conjunto FILTRADO, antes do limit: do recorte, nunca da pagina.
  total_count bigint, class_a_count bigint, class_b_count bigint, class_c_count bigint,
  class_a_value numeric, class_b_value numeric, class_c_value numeric,
  without_full_count bigint,
  total_revenue numeric, total_units numeric, total_orders numeric,
  moved_up_count bigint, moved_down_count bigint, kept_count bigint, new_count bigint,
  -- O total do criterio no recorte inteiro (sem os filtros de depois da curva),
  -- agora e no periodo anterior: a variacao do recorte.
  scope_total_value numeric, prev_scope_total_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with criterio as (
    select case when p_criterion in ('unidades', 'pedidos') then p_criterion else 'faturamento' end as c
  ),
  sk as (
    select s.id, s.sku, s.title, s.supplier_brand, s.brand as category, s.kind, s.purchase_cost
    from public.skus s
    where s.organization_id = p_organization_id
      and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
      and (p_category is null or s.brand = p_category)
      and (p_kind is null or s.kind = p_kind)
  ),
  atual as (
    select m.sku_id,
      sum(m.gross_revenue) as revenue,
      sum(m.units_sold)::numeric as units,
      sum(m.orders_count)::numeric as orders
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
    group by m.sku_id
  ),
  valores as (
    select a.sku_id, 'faturamento' as crit, a.revenue as v from atual a where a.revenue > 0
    union all
    select a.sku_id, 'unidades', a.units from atual a where a.units > 0
    union all
    select a.sku_id, 'pedidos', a.orders from atual a where a.orders > 0
  ),
  ranking as (
    select v.sku_id, v.crit, v.v,
      round(v.v / sum(v.v) over (partition by v.crit) * 100, 2) as share,
      round(sum(v.v) over (partition by v.crit order by v.v desc, v.sku_id) / sum(v.v) over (partition by v.crit) * 100, 2)
        as cumulative,
      round((sum(v.v) over (partition by v.crit order by v.v desc, v.sku_id) - v.v) / sum(v.v) over (partition by v.crit) * 100, 2)
        as before
    from valores v
  ),
  classes as (
    select r.*, case when r.before < 80 then 'A' when r.before < 95 then 'B' else 'C' end as classe
    from ranking r
  ),
  anterior as (
    select m.sku_id,
      case (select c from criterio)
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos' then sum(m.orders_count)::numeric
        else sum(m.gross_revenue)
      end as v
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where p_prev_from is not null
      and p_prev_to is not null
      and m.organization_id = p_organization_id
      and m.metric_date between p_prev_from and p_prev_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
    group by m.sku_id
  ),
  anterior_classe as (
    select a.sku_id, a.v,
      case
        when round((sum(a.v) over (order by a.v desc, a.sku_id) - a.v) / sum(a.v) over () * 100, 2) < 80 then 'A'
        when round((sum(a.v) over (order by a.v desc, a.sku_id) - a.v) / sum(a.v) over () * 100, 2) < 95 then 'B'
        else 'C'
      end as classe
    from anterior a
    where a.v > 0
  ),
  -- O Full de `get_sku_abc_curve` (D-173): um saldo por BUCKET, recapturado
  -- nos ultimos 3 dias, da conta escolhida.
  latest_full as (
    select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_by_sku as (select lf.sku_id, sum(lf.quantity) as full_quantity from latest_full lf group by lf.sku_id),
  -- O estoque fisico e da organizacao, nao da conta (D-236): nao segue o recorte de conta.
  saldo_local as (
    select b.sku_id, b.quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
  ),
  base as (
    select c.sku_id, sk.sku, sk.title, sk.supplier_brand, sk.category, sk.kind, sk.purchase_cost,
      a.revenue, a.units, a.orders,
      c.v as metric_value, c.share as metric_share, c.cumulative as cumulative_share, c.classe as abc_class,
      cf.classe as class_revenue, cu.classe as class_units, cp.classe as class_orders,
      ac.v as prev_metric_value, ac.classe as prev_abc_class,
      case
        when p_prev_from is null or p_prev_to is null then null
        when ac.classe is null then 'novo'
        when c.classe < ac.classe then 'subiu'
        when c.classe > ac.classe then 'caiu'
        else 'manteve'
      end as movement,
      -- Sem linha de saldo e "nao registrado", nao zero (D-067).
      sl.quantity as local_stock,
      coalesce(fb.full_quantity, 0) as full_stock,
      -- Dias que o estoque (local + Full) cobre na venda media diaria do periodo.
      case
        when sl.quantity is null or a.units <= 0 then null
        else round(
          (greatest(sl.quantity, 0) + greatest(coalesce(fb.full_quantity, 0), 0))
          / (a.units / (p_date_to - p_date_from + 1)), 1)
      end as coverage_days
    from classes c
    join atual a on a.sku_id = c.sku_id
    join sk on sk.id = c.sku_id
    left join classes cf on cf.sku_id = c.sku_id and cf.crit = 'faturamento'
    left join classes cu on cu.sku_id = c.sku_id and cu.crit = 'unidades'
    left join classes cp on cp.sku_id = c.sku_id and cp.crit = 'pedidos'
    left join anterior_classe ac on ac.sku_id = c.sku_id
    left join full_by_sku fb on fb.sku_id = c.sku_id
    left join saldo_local sl on sl.sku_id = c.sku_id
    where c.crit = (select cr.c from criterio cr)
  ),
  filtrada as (
    select b.* from base b
    where (p_abc_class is null or b.abc_class = p_abc_class)
      and (not p_only_without_full or b.full_stock = 0)
      and (p_stock is null
           or (p_stock = 'sem_local' and coalesce(b.local_stock, 0) <= 0)
           or (p_stock = 'sem_estoque' and coalesce(b.local_stock, 0) <= 0 and b.full_stock <= 0)
           or (p_stock = 'com_estoque' and (coalesce(b.local_stock, 0) > 0 or b.full_stock > 0)))
      and (p_movement is null or b.movement = p_movement)
      -- `strpos` e nao `ilike`: o texto digitado nao vira curinga (`%`, `_`).
      and (p_search is null
           or strpos(lower(b.sku), lower(p_search)) > 0
           or strpos(lower(coalesce(b.title, '')), lower(p_search)) > 0)
  )
  select f.sku_id, f.sku, f.title, f.supplier_brand, f.category, f.kind, f.purchase_cost,
    f.revenue, f.units, f.orders,
    f.metric_value, f.metric_share, f.cumulative_share, f.abc_class,
    f.class_revenue, f.class_units, f.class_orders,
    f.prev_metric_value, f.prev_abc_class, f.movement,
    f.local_stock, f.full_stock, f.coverage_days,
    count(*) over () as total_count,
    count(*) filter (where f.abc_class = 'A') over () as class_a_count,
    count(*) filter (where f.abc_class = 'B') over () as class_b_count,
    count(*) filter (where f.abc_class = 'C') over () as class_c_count,
    coalesce(sum(f.metric_value) filter (where f.abc_class = 'A') over (), 0) as class_a_value,
    coalesce(sum(f.metric_value) filter (where f.abc_class = 'B') over (), 0) as class_b_value,
    coalesce(sum(f.metric_value) filter (where f.abc_class = 'C') over (), 0) as class_c_value,
    count(*) filter (where f.full_stock = 0) over () as without_full_count,
    sum(f.revenue) over () as total_revenue,
    sum(f.units) over () as total_units,
    sum(f.orders) over () as total_orders,
    count(*) filter (where f.movement = 'subiu') over () as moved_up_count,
    count(*) filter (where f.movement = 'caiu') over () as moved_down_count,
    count(*) filter (where f.movement = 'manteve') over () as kept_count,
    count(*) filter (where f.movement = 'novo') over () as new_count,
    (select sum(c.v) from classes c where c.crit = (select cr.c from criterio cr)) as scope_total_value,
    (select sum(ac.v) from anterior_classe ac) as prev_scope_total_value
  from filtrada f
  order by
    case when p_order = 'faturamento' then f.revenue end desc nulls last,
    case when p_order = 'unidades' then f.units end desc nulls last,
    case when p_order = 'pedidos' then f.orders end desc nulls last,
    case when p_order = 'crescimento' then f.metric_value - coalesce(f.prev_metric_value, 0) end desc nulls last,
    case when p_order = 'queda' then f.metric_value - coalesce(f.prev_metric_value, 0) end asc nulls last,
    case when p_order = 'estoque' then coalesce(f.local_stock, 0) + f.full_stock end desc nulls last,
    case when p_order = 'cobertura' then f.coverage_days end asc nulls last,
    case when p_order = 'nome' then lower(coalesce(f.title, f.sku)) end asc nulls last,
    f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer) is
  'D-424: Curva ABC por SKU com as tres metricas, a classe em cada criterio, o periodo anterior, estoque e cobertura. Conta, marca, categoria e tipo recalculam a curva; classe, Full, estoque, movimento e busca filtram depois dela. Totais e contagens sao janelas antes do limit. security invoker.';

revoke all on function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Os recortes agregados do painel do Excel: por conta, marca, categoria,
--    mes e a migracao de classe. Soma no Postgres (regra do projeto), com a
--    classe do SKU tirada da curva do recorte inteiro.
-- ---------------------------------------------------------------------------
create function public.get_sku_abc_breakdown(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  -- 'conta' | 'marca' | 'categoria' | 'mes' | 'migracao'
  p_dimension text,
  p_prev_from date default null,
  p_prev_to date default null,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_category text default null,
  p_kind text default null,
  p_criterion text default 'faturamento'
)
returns table (
  group_key text, group_label text,
  revenue numeric, units numeric, orders numeric, sku_count bigint,
  -- O valor DO CRITERIO por classe do SKU (faturamento, unidades ou pedidos).
  class_a_value numeric, class_b_value numeric, class_c_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with criterio as (
    select case when p_criterion in ('unidades', 'pedidos') then p_criterion else 'faturamento' end as c
  ),
  sk as (
    select s.id, s.supplier_brand, s.brand as category
    from public.skus s
    where s.organization_id = p_organization_id
      and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
      and (p_category is null or s.brand = p_category)
      and (p_kind is null or s.kind = p_kind)
  ),
  linhas as (
    select m.sku_id, m.ml_account_id, m.metric_date, m.gross_revenue, m.units_sold::numeric as units_sold,
      m.orders_count::numeric as orders_count,
      case (select c from criterio)
        when 'unidades' then m.units_sold::numeric
        when 'pedidos' then m.orders_count::numeric
        else m.gross_revenue
      end as v
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
  ),
  por_sku as (
    select l.sku_id, sum(l.v) as v from linhas l group by l.sku_id having sum(l.v) > 0
  ),
  classe as (
    select p.sku_id,
      case
        when round((sum(p.v) over (order by p.v desc, p.sku_id) - p.v) / sum(p.v) over () * 100, 2) < 80 then 'A'
        when round((sum(p.v) over (order by p.v desc, p.sku_id) - p.v) / sum(p.v) over () * 100, 2) < 95 then 'B'
        else 'C'
      end as classe
    from por_sku p
  ),
  anterior as (
    select m.sku_id,
      case (select c from criterio)
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos' then sum(m.orders_count)::numeric
        else sum(m.gross_revenue)
      end as v
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where p_dimension = 'migracao'
      and p_prev_from is not null
      and p_prev_to is not null
      and m.organization_id = p_organization_id
      and m.metric_date between p_prev_from and p_prev_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
    group by m.sku_id
  ),
  anterior_classe as (
    select a.sku_id,
      case
        when round((sum(a.v) over (order by a.v desc, a.sku_id) - a.v) / sum(a.v) over () * 100, 2) < 80 then 'A'
        when round((sum(a.v) over (order by a.v desc, a.sku_id) - a.v) / sum(a.v) over () * 100, 2) < 95 then 'B'
        else 'C'
      end as classe
    from anterior a
    where a.v > 0
  ),
  -- A linha diaria com o grupo da dimensao e a classe do SKU no recorte.
  agrupada as (
    select
      case p_dimension
        when 'conta' then l.ml_account_id::text
        when 'marca' then coalesce(sk.supplier_brand, '')
        when 'categoria' then coalesce(sk.category, '')
        when 'mes' then to_char(l.metric_date, 'YYYY-MM')
      end as group_key,
      l.sku_id, l.gross_revenue, l.units_sold, l.orders_count, l.v, c.classe
    from linhas l
    join sk on sk.id = l.sku_id
    left join classe c on c.sku_id = l.sku_id
    where p_dimension in ('conta', 'marca', 'categoria', 'mes')
  ),
  grupos as (
    select g.group_key,
      sum(g.gross_revenue) as revenue,
      sum(g.units_sold) as units,
      sum(g.orders_count) as orders,
      count(distinct g.sku_id) filter (where g.v > 0) as sku_count,
      coalesce(sum(g.v) filter (where g.classe = 'A'), 0) as class_a_value,
      coalesce(sum(g.v) filter (where g.classe = 'B'), 0) as class_b_value,
      coalesce(sum(g.v) filter (where g.classe = 'C'), 0) as class_c_value
    from agrupada g
    group by g.group_key
  ),
  -- Migracao: classe no periodo anterior (ou 'Novo') -> classe agora (ou 'Sem venda').
  migracao as (
    select coalesce(ac.classe, 'Novo') as group_key, coalesce(c.classe, 'Sem venda') as group_label,
      count(*) as sku_count
    from classe c
    full join anterior_classe ac on ac.sku_id = c.sku_id
    where p_dimension = 'migracao'
    group by 1, 2
  )
  select g.group_key,
    case p_dimension
      when 'conta' then coalesce((select a.label from public.ml_accounts a where a.id::text = g.group_key), g.group_key)
      when 'marca' then coalesce(nullif(g.group_key, ''), 'Sem marca')
      when 'categoria' then coalesce(nullif(g.group_key, ''), 'Sem categoria')
      else g.group_key
    end,
    g.revenue, g.units, g.orders, g.sku_count, g.class_a_value, g.class_b_value, g.class_c_value
  from grupos g
  union all
  select m.group_key, m.group_label, null, null, null, m.sku_count, null, null, null
  from migracao m
  order by 1
$$;

comment on function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text) is
  'D-424: recortes agregados da Curva ABC (conta, marca, categoria, mes) com o valor do criterio por classe do SKU, e a migracao de classe contra o periodo anterior. security invoker.';

revoke all on function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text) from public, anon;
grant execute on function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Venda por SKU e conta: a aba "Por conta" do Excel (o 20017 nas 4 contas).
-- ---------------------------------------------------------------------------
create function public.get_sku_sales_by_account(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_supplier_brand text default null,
  p_category text default null,
  p_kind text default null,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (sku_id uuid, ml_account_id uuid, revenue numeric, units numeric, orders numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.sku_id, m.ml_account_id,
    sum(m.gross_revenue), sum(m.units_sold)::numeric, sum(m.orders_count)::numeric
  from public.daily_sku_metrics m
  join public.skus s on s.id = m.sku_id
  where m.organization_id = p_organization_id
    and m.metric_date between p_date_from and p_date_to
    and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
    and (p_category is null or s.brand = p_category)
    and (p_kind is null or s.kind = p_kind)
  group by m.sku_id, m.ml_account_id
  -- Ordem estavel por chave unica: a leitura em paginas nao repete nem pula.
  order by m.sku_id, m.ml_account_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer) is
  'D-424: faturamento, unidades e pedidos por SKU e conta no periodo, paginado. security invoker.';

revoke all on function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer) to authenticated, service_role;

-- `get_categories` para o filtro de categoria: os valores distintos de `skus.brand`
-- vem do banco, nunca das linhas da pagina (D-194).
create function public.get_sku_categories(p_organization_id uuid)
returns table (category text)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct s.brand
  from public.skus s
  where s.organization_id = p_organization_id
    and s.brand is not null
    and btrim(s.brand) <> ''
  order by 1
$$;

comment on function public.get_sku_categories(uuid) is
  'D-424: categorias distintas (skus.brand, a coluna Categorias do UpSeller, D-129) para o filtro da Curva ABC. security invoker.';

revoke all on function public.get_sku_categories(uuid) from public, anon;
grant execute on function public.get_sku_categories(uuid) to authenticated, service_role;
