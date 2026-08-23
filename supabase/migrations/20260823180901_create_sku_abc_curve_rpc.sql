create function public.get_sku_abc_curve(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  gross_revenue numeric,
  revenue_share numeric,
  cumulative_share numeric,
  abc_class text,
  full_quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with revenue as (
    select m.sku_id, sum(m.gross_revenue) as gross_revenue
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
    having sum(m.gross_revenue) > 0
  ),
  total as (
    select sum(gross_revenue) as total_revenue from revenue
  ),
  ranked as (
    select
      r.sku_id,
      r.gross_revenue,
      round(r.gross_revenue / nullif(t.total_revenue, 0) * 100, 2) as revenue_share,
      round(
        sum(r.gross_revenue) over (order by r.gross_revenue desc, r.sku_id) / nullif(t.total_revenue, 0) * 100,
        2
      ) as cumulative_share,
      round(
        (
          sum(r.gross_revenue) over (order by r.gross_revenue desc, r.sku_id)
          - r.gross_revenue
        ) / nullif(t.total_revenue, 0) * 100,
        2
      ) as cumulative_share_before
    from revenue r cross join total t
  ),
  latest_full as (
    select distinct on (f.ml_account_id, f.item_id, f.variation_id)
      f.sku_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
    order by f.ml_account_id, f.item_id, f.variation_id, f.captured_at desc
  ),
  full_by_sku as (
    select sku_id, sum(quantity) as full_quantity
    from latest_full
    group by sku_id
  )
  select
    sk.id as sku_id,
    sk.sku,
    sk.title,
    ranked.gross_revenue,
    ranked.revenue_share,
    ranked.cumulative_share,
    case
      when ranked.cumulative_share_before < 80 then 'A'
      when ranked.cumulative_share_before < 95 then 'B'
      else 'C'
    end as abc_class,
    coalesce(fb.full_quantity, 0) as full_quantity
  from ranked
  join public.skus sk on sk.id = ranked.sku_id
  left join full_by_sku fb on fb.sku_id = ranked.sku_id
  order by ranked.cumulative_share
$$;

comment on function public.get_sku_abc_curve(uuid, date, date) is
  'Curva ABC por receita (Pareto 80/15/5, convencao padrao de analytics de varejo). Classe decidida pelo percentual acumulado ANTES de somar o proprio SKU (cumulative_share_before), nao pelo percentual apos somar - senao um SKU dominante (ex.: sozinho responde por 99% da receita) cairia em C por seu proprio acumulado ultrapassar 95%, quando na verdade ele É o item mais importante (classe A). cumulative_share exposto na saida continua sendo o acumulado INCLUSIVE (leitura padrao de relatorio ABC). Janela FIXA de 90 dias na tela (mais longa que a de cobertura/30 dias: classificacao ABC precisa de sinal mais estavel, menos ruido de curto prazo). SKU sem venda no periodo fica de fora da curva (nao ha o que classificar). full_quantity e o ultimo snapshot conhecido de Full por SKU (get_stock_coverage cobre so LOCAL) - existe para o filtro "sem Full" da tela /curva-abc: entre os itens mais vendidos (classe A), quais dependem 100% de estoque local porque nao tem Full nenhum.';

revoke all on function public.get_sku_abc_curve(uuid, date, date) from public, anon;
grant execute on function public.get_sku_abc_curve(uuid, date, date) to authenticated, service_role;
