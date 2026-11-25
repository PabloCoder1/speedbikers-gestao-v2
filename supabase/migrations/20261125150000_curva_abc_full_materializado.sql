-- D-873: a curva ABC deixa de refazer a soma do Full para cada SKU.
--
-- `get_sku_abc_curve` e `language sql` com `set search_path = ''`: roda com o plano
-- GENERICO dos parametros (a mesma causa da D-872). Nesse plano, a CTE
-- `full_by_sku`, usada uma vez, e incorporada a consulta e recalculada para
-- cada linha da curva, num laco que descartava centenas de milhares de
-- linhas. Medido em producao em 25/11, como membro: 1,3 a
-- 1,6 s por chamada sem filtro; o mesmo SQL por extenso, 380 a 570 ms.
--
-- `as materialized` calcula a soma uma vez. Plano generico forcado em producao:
-- 3,1 s para 483 ms. Nos 10 recortes conferidos em producao, as duas versoes
-- devolveram as mesmas linhas (hash de todas as linhas). Mesma assinatura e
-- mesmo retorno; `create or replace` preserva comentario e grants.

create or replace function public.get_sku_abc_curve(
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
  p_sku_id uuid default null,
  -- Classe opcional, aplicada apos o ranking para preservar a curva ABC.
  p_abc_class text default null
)
returns table (
  sku_id uuid, sku text, title text, metric_value numeric, metric_share numeric,
  cumulative_share numeric, abc_class text, full_quantity numeric,
  total_count bigint, class_a_count bigint, class_b_count bigint, class_c_count bigint,
  -- Somas POR CLASSE, para os tres cartoes do frame (D-251). Elas moram aqui,
  -- e nao numa RPC separada, por medicao: a janela custa 0,2 ms sobre uma
  -- funcao que ja leva 332 ms -- uma segunda chamada DOBRARIA o custo da tela
  -- para produzir tres numeros.
  class_a_value numeric, class_b_value numeric, class_c_value numeric,
  -- Quantos SKUs do recorte estao SEM Full. Pareia com `p_only_without_full`,
  -- que ja existe: a barra promete um numero e o filtro entrega a lista.
  without_full_count bigint
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
  -- `materialized` (D-873): sem ele, o plano generico refaz esta soma para
  -- cada linha da curva, num laco que descarta centenas de milhares de linhas.
  full_by_sku as materialized (select sku_id, sum(quantity) as full_quantity from latest_full group by sku_id),
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
      and (p_abc_class is null or abc_class = p_abc_class)
  )
  select f.sku_id, f.sku, f.title, f.metric_value, f.metric_share, f.cumulative_share,
         f.abc_class, f.full_quantity,
         count(*) over ()                                as total_count,
         count(*) filter (where f.abc_class='A') over () as class_a_count,
         count(*) filter (where f.abc_class='B') over () as class_b_count,
         count(*) filter (where f.abc_class='C') over () as class_c_count,
         -- As janelas rodam sobre `filtrada`, ANTES do limit/offset -- entao
         -- sao do conjunto inteiro, nunca da pagina. Mesma posicao das
         -- contagens que ja estavam aqui.
         coalesce(sum(f.metric_value) filter (where f.abc_class='A') over (), 0) as class_a_value,
         coalesce(sum(f.metric_value) filter (where f.abc_class='B') over (), 0) as class_b_value,
         coalesce(sum(f.metric_value) filter (where f.abc_class='C') over (), 0) as class_c_value,
         count(*) filter (where f.full_quantity = 0) over ()                     as without_full_count
  from filtrada f
  order by f.cumulative_share, f.sku_id
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;
