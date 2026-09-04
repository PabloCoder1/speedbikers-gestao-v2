-- ============================================================
-- A curva ABC responde por UM SKU (D-247) — o selo "Curva A" do cabecalho.
--
-- O frame `SkuDetailScreen` mostra tres selos no cartao de entidade: estado,
-- **classe ABC** e marca (App.tsx:3890-3892). A classe e canonica em SQL desde
-- D-140, mas so era alcancavel pela tela `/curva-abc`, que pede a curva
-- inteira. A auditoria de fidelidade (A1) registrou o selo como pendente por
-- falta deste argumento.
--
-- **`p_sku_id` filtra DEPOIS do ranking, e essa e a unica posicao correta.**
-- A classe de um SKU e a sua posicao na curva do CONJUNTO: filtrar antes
-- deixaria um SKU sozinho respondendo por 100% do acumulado e ele sairia
-- sempre "A". O filtro entra em `filtrada`, ao lado de `p_only_without_full`,
-- que ja usa exatamente esse lugar pelo mesmo motivo.
--
-- **Consequencia declarada:** com `p_sku_id`, `total_count` e os tres
-- `class_*_count` passam a contar o conjunto FILTRADO (1 e 0/0/0) — sao
-- janelas sobre `filtrada`. Quem chama por SKU le `abc_class`; quem quer o
-- retrato da curva nao passa o argumento. Mesmo comportamento que
-- `p_only_without_full` ja tinha.
--
-- Argumento no FIM da assinatura (licao de D-242): a suite de integracao e as
-- telas chamam por nome, mas SQL de teste chama por posicao.
--
-- DROP + CREATE porque a lista de argumentos muda (42P13); grant e comment
-- recriados, com o `revoke` de D-182 antes do grant.
-- ============================================================

drop function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text);

create function public.get_sku_abc_curve(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_criterion text default 'faturamento',
  p_only_without_full boolean default false,
  p_limit integer default 200,
  p_offset integer default 0,
  p_supplier_brand text default null,
  -- Um SKU so, DEPOIS do ranking: a classe continua sendo a da curva inteira.
  p_sku_id uuid default null
)
returns table (
  sku_id uuid, sku text, title text, metric_value numeric, metric_share numeric,
  cumulative_share numeric, abc_class text, full_quantity numeric,
  total_count bigint, class_a_count bigint, class_b_count bigint, class_c_count bigint
)
language sql
stable
security invoker
set search_path = ''
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
      -- Marca no MESMO lugar da conta: a curva e recalculada DENTRO da marca,
      -- nao a fatia da marca na curva global.
      and (p_supplier_brand is null
           or exists (
                select 1 from public.skus sk
                where sk.id = m.sku_id and sk.supplier_brand = p_supplier_brand))
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
    where (not p_only_without_full or full_quantity = 0)
      and (p_sku_id is null or sku_id = p_sku_id)
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

comment on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid) is
  'Curva ABC por receita (Pareto 80/15/5). Classe decidida pelo percentual acumulado ANTES de somar o proprio SKU (cumulative_share_before), nao pelo percentual apos somar - senao um SKU dominante cairia em C por seu proprio acumulado ultrapassar 95%, quando na verdade ele E o item mais importante (classe A). Janela FIXA de 90 dias na tela. SKU sem venda no periodo fica de fora (nao ha o que classificar). full_quantity e o ultimo snapshot por inventory_id nos ultimos 3 dias (D-173). `p_sku_id` (D-247) filtra DEPOIS do ranking, para a classe continuar sendo a da curva inteira; com ele, total_count e os class_*_count contam o conjunto filtrado, como ja acontece com p_only_without_full.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova (D-182): revogar ANTES do
-- grant, senao `anon` alcanca a RPC.
revoke execute on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid) from public, anon;
grant execute on function public.get_sku_abc_curve(uuid, date, date, uuid, text, boolean, integer, integer, text, uuid) to authenticated, service_role;
