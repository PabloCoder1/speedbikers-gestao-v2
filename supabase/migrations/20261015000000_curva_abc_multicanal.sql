-- ============================================================
-- D-441 -- curva ABC por marketplace (etapa E6b da frente multicanal;
-- contrato C-60 para a T6 do Agente 2).
--
-- A Curva ABC (D-424) passa a aceitar o marketplace e as contas/lojas como
-- RECORTES -- entram no conjunto e no denominador, a curva e recalculada
-- dentro deles, como conta, marca, categoria e tipo. Sao as MESMAS tres
-- funcoes (a tela, o painel do Excel e a aba "Por conta"), com dois
-- parametros novos no fim; nenhuma tela muda de RPC.
--
-- p_marketplaces nulo = so o Mercado Livre: o resultado do ML e o de antes,
-- linha por linha (conferido por md5 contra as funcoes antigas no mesmo
-- banco, D-441). p_account_ids sao ids de `marketplace_accounts` (C-52):
-- conta ML e loja Shopee.
--
-- O que soma entre os marketplaces (METRICS 5T e D-439): unidades, receita
-- bruta (a da Shopee e a do item, `shopee_sales_items`; item de preco 0 e
-- receita desconhecida, contada a parte e nunca zero) e COMPRAS (o pack do
-- ML e o pedido Shopee que contem o SKU). "Pedidos" e a linha de pedido do
-- ML e nao soma com a Shopee: com a Shopee no recorte, `orders` vem nulo e o
-- criterio `pedidos` e recusado -- o terceiro criterio passa a ser `compras`,
-- que tambem vale so com o ML.
--
-- Fica como esta, de proposito:
-- - a COBERTURA vem nula com a Shopee no recorte: cobertura e sugestao de
--   compra nao leem a demanda da Shopee ate a fatia 5 (decisao do dono,
--   14/10);
-- - o Full e do ML: nulo quando o recorte nao le o ML, e "sem Full" so com o
--   ML;
-- - `get_sku_abc_curve` (a pagina do SKU e a prioridade de compra) continua
--   so ML.
--
-- As tres viram plpgsql com plano custom (D-305/D-319: leitura parametrizada
-- que agrega e ordena), para validar o recorte e recusar combinacoes que
-- dariam numero errado em vez de devolver vazio.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A analise por SKU (a tela /curva-abc e as curvas do Excel).
-- ------------------------------------------------------------
drop function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer);

create function public.get_sku_abc_analysis(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  -- O periodo de comparacao. Nulo: sem comparacao (movimento nulo).
  p_prev_from date default null,
  p_prev_to date default null,
  -- A conta do ML de antes (so com o ML no recorte; com a Shopee, use
  -- p_account_ids).
  p_ml_account_id uuid default null,
  -- `skus.supplier_brand`, a marca real (D-129/D-235).
  p_supplier_brand text default null,
  -- `skus.brand`, que guarda a CATEGORIA do UpSeller (D-129).
  p_category text default null,
  p_kind text default null,
  -- 'faturamento' | 'unidades' | 'pedidos' (so ML) | 'compras'
  p_criterion text default 'faturamento',
  p_abc_class text default null,
  p_only_without_full boolean default false,
  -- 'sem_local' | 'sem_estoque' | 'com_estoque'
  p_stock text default null,
  -- 'subiu' | 'caiu' | 'manteve' | 'novo'
  p_movement text default null,
  p_search text default null,
  -- 'curva' | 'faturamento' | 'unidades' | 'pedidos' | 'compras' | 'crescimento'
  -- | 'queda' | 'estoque' | 'cobertura' | 'nome'
  p_order text default 'curva',
  p_limit integer default 50,
  p_offset integer default 0,
  -- D-441: 'ML' e/ou 'SHOPEE'. Nulo = so o ML.
  p_marketplaces text[] default null,
  -- D-441: contas ML e lojas Shopee (ids de `marketplace_accounts`). Nulo = todas.
  p_account_ids uuid[] default null
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
  scope_total_value numeric, prev_scope_total_value numeric,
  -- D-441: compras (pack do ML + pedido Shopee) e a classe nelas; a parte de
  -- cada marketplace (nula = o marketplace nao esta no recorte ou nao vendeu);
  -- itens Shopee de receita desconhecida (a receita do SKU e a conhecida).
  purchases numeric, class_purchases text,
  revenue_ml numeric, units_ml numeric, purchases_ml numeric,
  revenue_shopee numeric, units_shopee numeric, purchases_shopee numeric,
  shopee_items_without_revenue bigint,
  total_purchases numeric, total_shopee_items_without_revenue bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
  v_criterio text := case when p_criterion in ('unidades', 'pedidos', 'compras') then p_criterion else 'faturamento' end;
  v_com_shopee boolean;
  v_le_ml boolean;
  v_le_shopee boolean;
begin
  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  v_com_shopee := 'SHOPEE' = any (v_marketplaces);

  if v_com_shopee and v_criterio = 'pedidos' then
    raise exception 'pedidos nao soma entre marketplaces (D-441): com a Shopee no recorte, use compras';
  end if;

  if v_com_shopee and p_ml_account_id is not null then
    raise exception 'com a Shopee no recorte, a conta vai em p_account_ids (D-441)';
  end if;

  -- Cada lado so e lido com o marketplace no recorte e, havendo contas
  -- escolhidas, com alguma delas daquele marketplace.
  v_le_ml := 'ML' = any (v_marketplaces)
    and (p_account_ids is null or exists (select 1 from public.ml_accounts a where a.id = any (p_account_ids)));
  v_le_shopee := v_com_shopee
    and (p_account_ids is null or exists (select 1 from public.shopee_shops s where s.id = any (p_account_ids)));

  if p_only_without_full and not v_le_ml then
    raise exception 'o filtro sem Full so vale com o Mercado Livre no recorte (D-441)';
  end if;

  return query
  with sk as (
    select s.id, s.sku, s.title, s.supplier_brand, s.brand as category, s.kind, s.purchase_cost
    from public.skus s
    where s.organization_id = p_organization_id
      and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
      and (p_category is null or s.brand = p_category)
      and (p_kind is null or s.kind = p_kind)
  ),
  ml_atual as (
    select m.sku_id,
      sum(m.gross_revenue) as revenue,
      sum(m.units_sold)::numeric as units,
      sum(m.orders_count)::numeric as orders,
      sum(m.purchases_count)::numeric as purchases
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where v_le_ml
      and m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (p_account_ids is null or m.ml_account_id = any (p_account_ids))
    group by m.sku_id
  ),
  -- O grao de SKU da Shopee (D-439): item de pedido VALIDO de loja real, no
  -- dia de Sao Paulo da criacao do pedido.
  shopee_atual as (
    select it.sku_id,
      sum(it.receita_item) as revenue,
      sum(it.quantity)::numeric as units,
      count(distinct (it.shopee_shop_id, it.order_sn))::numeric as purchases,
      count(*) filter (where it.receita_item is null) as sem_receita
    from public.shopee_sales_items it
    join sk on sk.id = it.sku_id
    where v_le_shopee
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.sku_id
  ),
  atual as (
    select coalesce(a.sku_id, s.sku_id) as sku_id,
      -- A receita conhecida dos dois lados; sem nenhuma conhecida, NULO.
      case when a.revenue is null and s.revenue is null then null
           else coalesce(a.revenue, 0) + coalesce(s.revenue, 0) end as revenue,
      coalesce(a.units, 0) + coalesce(s.units, 0) as units,
      -- A linha de pedido do ML nao soma com o pedido Shopee.
      case when v_com_shopee then null else a.orders end as orders,
      coalesce(a.purchases, 0) + coalesce(s.purchases, 0) as purchases,
      a.revenue as revenue_ml, a.units as units_ml, a.purchases as purchases_ml,
      s.revenue as revenue_shopee, s.units as units_shopee, s.purchases as purchases_shopee,
      s.sem_receita
    from ml_atual a
    full join shopee_atual s on s.sku_id = a.sku_id
  ),
  valores as (
    select a.sku_id, 'faturamento' as crit, a.revenue as v from atual a where a.revenue > 0
    union all
    select a.sku_id, 'unidades', a.units from atual a where a.units > 0
    union all
    select a.sku_id, 'pedidos', a.orders from atual a where a.orders > 0
    union all
    select a.sku_id, 'compras', a.purchases from atual a where a.purchases > 0
  ),
  -- A CLASSE e a de `get_sku_abc_curve` (D-140/D-424): valor maior que zero,
  -- ordem decrescente com desempate por sku_id, e a classe pelo acumulado
  -- ANTES do SKU arredondado em 2 casas (A abaixo de 80, B abaixo de 95).
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
  anterior_ml as (
    select m.sku_id,
      case v_criterio
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos' then sum(m.orders_count)::numeric
        when 'compras' then sum(m.purchases_count)::numeric
        else sum(m.gross_revenue)
      end as v
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where v_le_ml
      and p_prev_from is not null
      and p_prev_to is not null
      and m.organization_id = p_organization_id
      and m.metric_date between p_prev_from and p_prev_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (p_account_ids is null or m.ml_account_id = any (p_account_ids))
    group by m.sku_id
  ),
  anterior_shopee as (
    select it.sku_id,
      case v_criterio
        when 'unidades' then sum(it.quantity)::numeric
        when 'compras' then count(distinct (it.shopee_shop_id, it.order_sn))::numeric
        else sum(it.receita_item)
      end as v
    from public.shopee_sales_items it
    join sk on sk.id = it.sku_id
    where v_le_shopee
      and p_prev_from is not null
      and p_prev_to is not null
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and it.shopee_created_at >= (p_prev_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_prev_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.sku_id
  ),
  anterior as (
    select x.sku_id, sum(x.v) as v
    from (select am.sku_id, am.v from anterior_ml am union all select ash.sku_id, ash.v from anterior_shopee ash) x
    group by x.sku_id
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
  -- nos ultimos 3 dias, das contas do recorte. So existe com o ML no recorte.
  latest_full as (
    select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where v_le_ml
      and f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
      and (p_account_ids is null or f.ml_account_id = any (p_account_ids))
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
      case when v_le_ml then coalesce(fb.full_quantity, 0) end as full_stock,
      -- Dias que o estoque (local + Full) cobre na venda media diaria do
      -- periodo. Com a Shopee no recorte: nulo ate a fatia 5.
      case
        when v_com_shopee then null
        when sl.quantity is null or a.units <= 0 then null
        else round(
          (greatest(sl.quantity, 0) + greatest(coalesce(fb.full_quantity, 0), 0))
          / (a.units / (p_date_to - p_date_from + 1)), 1)
      end as coverage_days,
      a.purchases, cc.classe as class_purchases,
      a.revenue_ml, a.units_ml, a.purchases_ml,
      a.revenue_shopee, a.units_shopee, a.purchases_shopee,
      a.sem_receita as shopee_items_without_revenue
    from classes c
    join atual a on a.sku_id = c.sku_id
    join sk on sk.id = c.sku_id
    left join classes cf on cf.sku_id = c.sku_id and cf.crit = 'faturamento'
    left join classes cu on cu.sku_id = c.sku_id and cu.crit = 'unidades'
    left join classes cp on cp.sku_id = c.sku_id and cp.crit = 'pedidos'
    left join classes cc on cc.sku_id = c.sku_id and cc.crit = 'compras'
    left join anterior_classe ac on ac.sku_id = c.sku_id
    left join full_by_sku fb on fb.sku_id = c.sku_id
    left join saldo_local sl on sl.sku_id = c.sku_id
    where c.crit = v_criterio
  ),
  filtrada as (
    select b.* from base b
    where (p_abc_class is null or b.abc_class = p_abc_class)
      and (not p_only_without_full or b.full_stock = 0)
      and (p_stock is null
           or (p_stock = 'sem_local' and coalesce(b.local_stock, 0) <= 0)
           or (p_stock = 'sem_estoque' and coalesce(b.local_stock, 0) <= 0 and coalesce(b.full_stock, 0) <= 0)
           or (p_stock = 'com_estoque' and (coalesce(b.local_stock, 0) > 0 or coalesce(b.full_stock, 0) > 0)))
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
    count(*) over (),
    count(*) filter (where f.abc_class = 'A') over (),
    count(*) filter (where f.abc_class = 'B') over (),
    count(*) filter (where f.abc_class = 'C') over (),
    coalesce(sum(f.metric_value) filter (where f.abc_class = 'A') over (), 0),
    coalesce(sum(f.metric_value) filter (where f.abc_class = 'B') over (), 0),
    coalesce(sum(f.metric_value) filter (where f.abc_class = 'C') over (), 0),
    count(*) filter (where f.full_stock = 0) over (),
    sum(f.revenue) over (),
    sum(f.units) over (),
    sum(f.orders) over (),
    count(*) filter (where f.movement = 'subiu') over (),
    count(*) filter (where f.movement = 'caiu') over (),
    count(*) filter (where f.movement = 'manteve') over (),
    count(*) filter (where f.movement = 'novo') over (),
    (select sum(c.v) from classes c where c.crit = v_criterio),
    (select sum(ac.v) from anterior_classe ac),
    f.purchases, f.class_purchases,
    f.revenue_ml, f.units_ml, f.purchases_ml,
    f.revenue_shopee, f.units_shopee, f.purchases_shopee,
    f.shopee_items_without_revenue,
    sum(f.purchases) over (),
    (sum(f.shopee_items_without_revenue) over ())::bigint
  from filtrada f
  order by
    case when p_order = 'faturamento' then f.revenue end desc nulls last,
    case when p_order = 'unidades' then f.units end desc nulls last,
    case when p_order = 'pedidos' then f.orders end desc nulls last,
    case when p_order = 'compras' then f.purchases end desc nulls last,
    case when p_order = 'crescimento' then f.metric_value - coalesce(f.prev_metric_value, 0) end desc nulls last,
    case when p_order = 'queda' then f.metric_value - coalesce(f.prev_metric_value, 0) end asc nulls last,
    case when p_order = 'estoque' then coalesce(f.local_stock, 0) + coalesce(f.full_stock, 0) end desc nulls last,
    case when p_order = 'cobertura' then f.coverage_days end asc nulls last,
    case when p_order = 'nome' then lower(coalesce(f.title, f.sku)) end asc nulls last,
    f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
end;
$$;

comment on function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer, text[], uuid[]) is
  'D-424/D-441: Curva ABC por SKU com faturamento, unidades, pedidos (so ML) e compras, a classe em cada criterio, o periodo anterior, estoque e cobertura. Marketplace, conta/loja, marca, categoria e tipo recalculam a curva; classe, Full, estoque, movimento e busca filtram depois dela. p_marketplaces nulo = so ML (o resultado de antes). Com a Shopee: orders e cobertura nulos, criterio pedidos recusado. security invoker.';

revoke all on function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer, text[], uuid[]) from public, anon;
grant execute on function public.get_sku_abc_analysis(uuid, date, date, date, date, uuid, text, text, text, text, text, boolean, text, text, text, text, integer, integer, text[], uuid[]) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Os recortes agregados do painel do Excel: por conta (e loja), por
--    marketplace, marca, categoria, mes e a migracao de classe. Soma no
--    Postgres, com a classe do SKU tirada da curva do recorte inteiro.
-- ------------------------------------------------------------
drop function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text);

create function public.get_sku_abc_breakdown(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  -- 'conta' | 'marketplace' | 'marca' | 'categoria' | 'mes' | 'migracao'
  p_dimension text,
  p_prev_from date default null,
  p_prev_to date default null,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_category text default null,
  p_kind text default null,
  p_criterion text default 'faturamento',
  -- D-441: os mesmos recortes de `get_sku_abc_analysis`.
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null
)
returns table (
  group_key text, group_label text,
  revenue numeric, units numeric, orders numeric, sku_count bigint,
  -- O valor DO CRITERIO por classe do SKU (faturamento, unidades, pedidos ou compras).
  class_a_value numeric, class_b_value numeric, class_c_value numeric,
  -- D-441: compras do grupo (a soma das do SKU: um carrinho com dois SKUs
  -- conta em cada um) e os itens Shopee de receita desconhecida.
  purchases numeric, shopee_items_without_revenue bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
  v_criterio text := case when p_criterion in ('unidades', 'pedidos', 'compras') then p_criterion else 'faturamento' end;
  v_com_shopee boolean;
  v_le_ml boolean;
  v_le_shopee boolean;
begin
  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  v_com_shopee := 'SHOPEE' = any (v_marketplaces);

  if v_com_shopee and v_criterio = 'pedidos' then
    raise exception 'pedidos nao soma entre marketplaces (D-441): com a Shopee no recorte, use compras';
  end if;

  if v_com_shopee and p_ml_account_id is not null then
    raise exception 'com a Shopee no recorte, a conta vai em p_account_ids (D-441)';
  end if;

  v_le_ml := 'ML' = any (v_marketplaces)
    and (p_account_ids is null or exists (select 1 from public.ml_accounts a where a.id = any (p_account_ids)));
  v_le_shopee := v_com_shopee
    and (p_account_ids is null or exists (select 1 from public.shopee_shops s where s.id = any (p_account_ids)));

  return query
  with sk as (
    select s.id, s.supplier_brand, s.brand as category
    from public.skus s
    where s.organization_id = p_organization_id
      and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
      and (p_category is null or s.brand = p_category)
      and (p_kind is null or s.kind = p_kind)
  ),
  -- Uma linha por SKU, conta/loja e dia, dos dois marketplaces.
  linhas_ml as (
    select m.sku_id, 'ML'::text as marketplace, m.ml_account_id as account_id, m.metric_date as dia,
      m.gross_revenue as revenue, m.units_sold::numeric as units, m.orders_count::numeric as orders,
      m.purchases_count::numeric as purchases, null::bigint as sem_receita
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where v_le_ml
      and m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (p_account_ids is null or m.ml_account_id = any (p_account_ids))
  ),
  linhas_shopee as (
    select it.sku_id, 'SHOPEE'::text as marketplace, it.shopee_shop_id as account_id, it.dia,
      sum(it.receita_item) as revenue, sum(it.quantity)::numeric as units, null::numeric as orders,
      count(distinct it.order_sn)::numeric as purchases, count(*) filter (where it.receita_item is null) as sem_receita
    from public.shopee_sales_items it
    join sk on sk.id = it.sku_id
    where v_le_shopee
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.sku_id, it.shopee_shop_id, it.dia
  ),
  linhas as (
    select l.*,
      case v_criterio
        when 'unidades' then l.units
        when 'pedidos' then l.orders
        when 'compras' then l.purchases
        else l.revenue
      end as v
    from (
      select lm.sku_id, lm.marketplace, lm.account_id, lm.dia, lm.revenue, lm.units, lm.orders, lm.purchases, lm.sem_receita
      from linhas_ml lm
      union all
      select ls.sku_id, ls.marketplace, ls.account_id, ls.dia, ls.revenue, ls.units, ls.orders, ls.purchases, ls.sem_receita
      from linhas_shopee ls
    ) l
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
  anterior_ml as (
    select m.sku_id,
      case v_criterio
        when 'unidades' then sum(m.units_sold)::numeric
        when 'pedidos' then sum(m.orders_count)::numeric
        when 'compras' then sum(m.purchases_count)::numeric
        else sum(m.gross_revenue)
      end as v
    from public.daily_sku_metrics m
    join sk on sk.id = m.sku_id
    where p_dimension = 'migracao'
      and v_le_ml
      and p_prev_from is not null
      and p_prev_to is not null
      and m.organization_id = p_organization_id
      and m.metric_date between p_prev_from and p_prev_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (p_account_ids is null or m.ml_account_id = any (p_account_ids))
    group by m.sku_id
  ),
  anterior_shopee as (
    select it.sku_id,
      case v_criterio
        when 'unidades' then sum(it.quantity)::numeric
        when 'compras' then count(distinct (it.shopee_shop_id, it.order_sn))::numeric
        else sum(it.receita_item)
      end as v
    from public.shopee_sales_items it
    join sk on sk.id = it.sku_id
    where p_dimension = 'migracao'
      and v_le_shopee
      and p_prev_from is not null
      and p_prev_to is not null
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and it.shopee_created_at >= (p_prev_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_prev_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    group by it.sku_id
  ),
  anterior as (
    select x.sku_id, sum(x.v) as v
    from (select am.sku_id, am.v from anterior_ml am union all select ash.sku_id, ash.v from anterior_shopee ash) x
    group by x.sku_id
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
        when 'conta' then l.account_id::text
        when 'marketplace' then l.marketplace
        when 'marca' then coalesce(sk.supplier_brand, '')
        when 'categoria' then coalesce(sk.category, '')
        when 'mes' then to_char(l.dia, 'YYYY-MM')
      end as group_key,
      l.sku_id, l.revenue, l.units, l.orders, l.purchases, l.sem_receita, l.v, c.classe
    from linhas l
    join sk on sk.id = l.sku_id
    left join classe c on c.sku_id = l.sku_id
    where p_dimension in ('conta', 'marketplace', 'marca', 'categoria', 'mes')
  ),
  grupos as (
    select g.group_key,
      sum(g.revenue) as revenue,
      sum(g.units) as units,
      case when v_com_shopee then null else sum(g.orders) end as orders,
      count(distinct g.sku_id) filter (where g.v > 0) as sku_count,
      coalesce(sum(g.v) filter (where g.classe = 'A'), 0) as class_a_value,
      coalesce(sum(g.v) filter (where g.classe = 'B'), 0) as class_b_value,
      coalesce(sum(g.v) filter (where g.classe = 'C'), 0) as class_c_value,
      sum(g.purchases) as purchases,
      sum(g.sem_receita)::bigint as sem_receita
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
      when 'conta' then coalesce(
        (select a.label from public.ml_accounts a where a.id::text = g.group_key),
        (select s.shop_name from public.shopee_shops s where s.id::text = g.group_key),
        g.group_key)
      when 'marketplace' then case g.group_key when 'ML' then 'Mercado Livre' when 'SHOPEE' then 'Shopee' else g.group_key end
      when 'marca' then coalesce(nullif(g.group_key, ''), 'Sem marca')
      when 'categoria' then coalesce(nullif(g.group_key, ''), 'Sem categoria')
      else g.group_key
    end,
    g.revenue, g.units, g.orders, g.sku_count, g.class_a_value, g.class_b_value, g.class_c_value,
    g.purchases, g.sem_receita
  from grupos g
  union all
  select m.group_key, m.group_label, null, null, null, m.sku_count, null, null, null, null, null
  from migracao m
  order by 1;
end;
$$;

comment on function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text, text[], uuid[]) is
  'D-424/D-441: recortes agregados da Curva ABC (conta e loja, marketplace, marca, categoria, mes) com o valor do criterio por classe do SKU, e a migracao de classe contra o periodo anterior. p_marketplaces nulo = so ML. Com a Shopee: orders nulo, criterio pedidos recusado. security invoker.';

revoke all on function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text, text[], uuid[]) from public, anon;
grant execute on function public.get_sku_abc_breakdown(uuid, date, date, text, date, date, uuid, text, text, text, text, text[], uuid[]) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Venda por SKU e conta/loja: a aba "Por conta" do Excel.
-- ------------------------------------------------------------
drop function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer);

create function public.get_sku_sales_by_account(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_supplier_brand text default null,
  p_category text default null,
  p_kind text default null,
  p_limit integer default 1000,
  p_offset integer default 0,
  -- D-441: os mesmos recortes de `get_sku_abc_analysis`.
  p_marketplaces text[] default null,
  p_account_ids uuid[] default null
)
returns table (
  sku_id uuid, ml_account_id uuid, revenue numeric, units numeric, orders numeric,
  -- D-441: a conta ML ou a loja Shopee da linha; `ml_account_id` e `orders`
  -- ficam nulos na linha da Shopee.
  marketplace text, account_id uuid, purchases numeric, shopee_items_without_revenue bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_marketplaces text[] := coalesce(p_marketplaces, array['ML']);
begin
  if cardinality(v_marketplaces) = 0 or not (v_marketplaces <@ array['ML', 'SHOPEE']) then
    raise exception 'marketplace invalido: % (use ML e/ou SHOPEE)', v_marketplaces;
  end if;

  return query
  with ml as (
    select m.sku_id, m.ml_account_id,
      sum(m.gross_revenue) as revenue, sum(m.units_sold)::numeric as units, sum(m.orders_count)::numeric as orders,
      sum(m.purchases_count)::numeric as purchases
    from public.daily_sku_metrics m
    join public.skus s on s.id = m.sku_id
    where 'ML' = any (v_marketplaces)
      and m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and (p_account_ids is null or m.ml_account_id = any (p_account_ids))
      and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
      and (p_category is null or s.brand = p_category)
      and (p_kind is null or s.kind = p_kind)
    group by m.sku_id, m.ml_account_id
  ),
  shopee as (
    select it.sku_id, it.shopee_shop_id,
      sum(it.receita_item) as revenue, sum(it.quantity)::numeric as units,
      count(distinct it.order_sn)::numeric as purchases, count(*) filter (where it.receita_item is null) as sem_receita
    from public.shopee_sales_items it
    join public.skus s on s.id = it.sku_id
    where 'SHOPEE' = any (v_marketplaces)
      and it.organization_id = p_organization_id
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and (p_account_ids is null or it.shopee_shop_id = any (p_account_ids))
      and it.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and it.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (p_supplier_brand is null or s.supplier_brand = p_supplier_brand)
      and (p_category is null or s.brand = p_category)
      and (p_kind is null or s.kind = p_kind)
    group by it.sku_id, it.shopee_shop_id
  ),
  linhas as (
    select ml.sku_id, ml.ml_account_id, ml.revenue, ml.units, ml.orders,
      'ML'::text as marketplace, ml.ml_account_id as account_id, ml.purchases, null::bigint as sem_receita
    from ml
    union all
    select sh.sku_id, null::uuid, sh.revenue, sh.units, null::numeric,
      'SHOPEE'::text, sh.shopee_shop_id, sh.purchases, sh.sem_receita
    from shopee sh
  )
  select l.sku_id, l.ml_account_id, l.revenue, l.units, l.orders,
    l.marketplace, l.account_id, l.purchases, l.sem_receita
  from linhas l
  -- Ordem estavel por chave unica: a leitura em paginas nao repete nem pula.
  order by l.sku_id, l.marketplace, l.account_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
end;
$$;

comment on function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer, text[], uuid[]) is
  'D-424/D-441: faturamento, unidades, pedidos (so ML) e compras por SKU e conta ML ou loja Shopee no periodo, paginado. p_marketplaces nulo = so ML. security invoker.';

revoke all on function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer, text[], uuid[]) from public, anon;
grant execute on function public.get_sku_sales_by_account(uuid, date, date, text, text, text, integer, integer, text[], uuid[]) to authenticated, service_role;
