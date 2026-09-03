-- ============================================================
-- Filtro de MARCA na Cobertura de estoque (D-236) -- segunda parte do item P1
-- "filtros de Conta / Origem / Marca nas telas em que fizerem sentido".
-- A primeira foi a Curva ABC (D-235).
--
-- ------------------------------------------------------------
-- 1. SEM FILTRO DE CONTA, E ISSO E REGRA DO PROPRIO ITEM
-- ------------------------------------------------------------
-- O item diz "preservando a distincao entre estoque fisico compartilhado e
-- Full por conta". Cobertura e sobre `inventory_balances` com
-- `location_kind = 'LOCAL'` -- **estoque fisico e da organizacao**, nao da
-- conta do Mercado Livre. Um seletor de conta aqui responderia uma pergunta
-- que o dado nao tem, exatamente o que `/estoque/movimentacoes` ja registrou
-- ("sem filtro de conta DE PROPOSITO"). So a marca entra.
--
-- ------------------------------------------------------------
-- 2. O PARAMETRO E O ULTIMO -- a licao de D-235, aplicada ANTES do erro
-- ------------------------------------------------------------
-- Em D-235 eu descobri tarde que `get_sku_abc_curve` tinha chamadores dentro
-- do proprio Postgres, e a mudanca no meio da assinatura derrubou 6 testes.
-- Aqui a pergunta foi feita ao catalogo ANTES de escrever:
--
--   select proname from pg_proc where prosrc like '%get_stock_coverage%'
--
-- Resultado: `get_stock_coverage_summary` chama de verdade, com **3
-- argumentos posicionais**; `get_sku_curation` so MENCIONA a funcao num
-- comentario (zero chamadas). Com `p_supplier_brand` no fim, a chamada de 3
-- argumentos continua valida e o `summary` e recriado por escolha (para
-- repassar o filtro), nao por obrigacao.
--
-- ------------------------------------------------------------
-- 3. ONDE O FILTRO ENTRA, E POR QUE AQUI NAO HA A DUVIDA DA CURVA ABC
-- ------------------------------------------------------------
-- Em D-235 a escolha entre filtrar na `base` ou depois da classificacao MUDAVA
-- os numeros, porque a curva tem denominador. **Cobertura nao tem**: cada
-- linha e um SKU e o calculo e local a ele (estoque local dividido pela venda
-- media). Filtrar so reduz o conjunto -- e por isso o filtro vai no lugar
-- obvio, o `join public.skus sk` que ja existia no fim, na forma da casa
-- (`p_supplier_brand is null or sk.supplier_brand = ...`).
--
-- Custo medido no Dev, quente, como limite superior (funcao inteira + filtro
-- por fora; filtrar por DENTRO e no maximo isso):
--
--   sem filtro     101 ms   14.252 buffers   3.253 linhas
--   'OFF RACER'     61 ms   14.042 buffers   2.407 linhas
--
-- Fica mais BARATO: os 187 buffers do `skus_supplier_brand_idx` (que ja
-- existia) sao pagos com folga por haver menos linha atravessando o resto.
--
-- ------------------------------------------------------------
-- 4. `history_days_90` NAO ACOMPANHA O FILTRO, E ISSO E DELIBERADO
-- ------------------------------------------------------------
-- A CTE `history` conta dias distintos com metrica **na organizacao**, e
-- alimenta a recusa `HISTORICO_INCOMPLETO` de `classifySalesTrend` (D-145):
-- *"se menos de 84 dos 90 dias tem metrica, a tendencia se recusa em vez de
-- repetir a mentira"*. Essa guarda e sobre o PIPELINE de metricas, nao sobre o
-- SKU nem sobre a marca.
--
-- Filtra-la por marca trocaria o significado de "nosso historico tem buracos"
-- para "esta marca vendeu em poucos dias" -- e passaria a recusar a tendencia
-- de toda marca pequena, por um motivo que nao e o dela. Fica organizacional.
-- ============================================================

drop function public.get_stock_coverage_summary(uuid, date, date);
drop function public.get_stock_coverage(uuid, date, date, uuid);

create function public.get_stock_coverage(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_sku_id uuid default null,
  -- ULTIMO de proposito (ver secao 2): mantem valida a chamada posicional de
  -- 3 argumentos que `get_stock_coverage_summary` faz.
  p_supplier_brand text default null
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  local_quantity numeric,
  units_sold bigint,
  avg_daily_sales numeric,
  days_of_coverage numeric,
  is_ruptura boolean,
  stock_is_virtual boolean,
  units_15d bigint,
  units_30d bigint,
  units_60d bigint,
  units_90d bigint,
  history_days_90 bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with sales as (
    select m.sku_id, sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  trend_windows as (
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 15), 0)::bigint as units_15d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 30), 0)::bigint as units_30d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 60), 0)::bigint as units_60d,
      coalesce(sum(m.units_sold), 0)::bigint as units_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
    group by m.sku_id
  ),
  history as (
    -- SEM filtro de marca, de proposito -- ver secao 4 do cabecalho: esta
    -- contagem e sobre o pipeline de metricas da ORGANIZACAO, e e o que
    -- sustenta a recusa HISTORICO_INCOMPLETO de D-145.
    select count(distinct m.metric_date)::bigint as history_days_90
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
  ),
  stock as (
    select b.sku_id, b.quantity as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
      and (p_sku_id is null or b.sku_id = p_sku_id)
  ),
  combined as (
    select coalesce(sales.sku_id, stock.sku_id) as sku_id, sales.units_sold, stock.local_quantity
    from sales
    full outer join stock on stock.sku_id = sales.sku_id
  )
  select
    sk.id,
    sk.sku,
    sk.title,
    coalesce(c.local_quantity, 0) as local_quantity,
    coalesce(c.units_sold, 0)::bigint as units_sold,
    round(coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0), 3) as avg_daily_sales,
    case
      when sk.stock_is_virtual then null
      when coalesce(c.units_sold, 0) = 0 then null
      else round(
        coalesce(c.local_quantity, 0)
        / (coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0)),
        1
      )
    end as days_of_coverage,
    (not sk.stock_is_virtual
       and coalesce(c.local_quantity, 0) <= 0
       and coalesce(c.units_sold, 0) > 0) as is_ruptura,
    sk.stock_is_virtual,
    coalesce(t.units_15d, 0),
    coalesce(t.units_30d, 0),
    coalesce(t.units_60d, 0),
    coalesce(t.units_90d, 0),
    h.history_days_90
  from combined c
  join public.skus sk on sk.id = c.sku_id
  left join trend_windows t on t.sku_id = c.sku_id
  cross join history h
  -- Forma da casa: `sk` ja estava juntado, entao o filtro cai aqui e nao
  -- precisa de join novo (diferente de `get_sku_abc_curve`, D-235).
  where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
$$;

comment on function public.get_stock_coverage(uuid, date, date, uuid, text) is
  'Cobertura de estoque por SKU (Fase 5B; p_supplier_brand desde D-236). Marca e `skus.supplier_brand`, nunca `skus.brand` -- esta guarda a CATEGORIA do UpSeller (D-129). NAO ha filtro de conta de proposito: estoque LOCAL e da organizacao, Full e que e por conta (regra do item P1). `history_days_90` continua ORGANIZACIONAL mesmo com filtro de marca: ela sustenta a recusa HISTORICO_INCOMPLETO de D-145, que e sobre o pipeline de metricas e nao sobre a marca. security invoker.';

revoke all on function public.get_stock_coverage(uuid, date, date, uuid, text) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date, uuid, text) to authenticated, service_role;

create function public.get_stock_coverage_summary(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_supplier_brand text default null
)
returns table (
  total bigint,
  em_ruptura bigint,
  virtuais bigint,
  sem_cobertura bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where c.is_ruptura)::bigint as em_ruptura,
    count(*) filter (where c.stock_is_virtual)::bigint as virtuais,
    count(*) filter (where c.days_of_coverage is null and not c.stock_is_virtual)::bigint as sem_cobertura
  from public.get_stock_coverage(p_organization_id, p_date_from, p_date_to, null, p_supplier_brand) c
$$;

comment on function public.get_stock_coverage_summary(uuid, date, date, text) is
  'Totais da tela de cobertura (D-131; p_supplier_brand desde D-236, repassado a get_stock_coverage). Existe porque a tela contava em JavaScript sobre um resultado truncado em 1.000 linhas pelo max_rows do PostgREST -- contagem sobre amostra arbitraria. Com filtro de marca os totais sao DA MARCA, que e o que a tela precisa dizer quando ha recorte. `sem_cobertura` exclui os virtuais de proposito: para esses o nulo e recusa deliberada (D-127), nao ausencia de venda.';

revoke all on function public.get_stock_coverage_summary(uuid, date, date, text) from public, anon;
grant execute on function public.get_stock_coverage_summary(uuid, date, date, text) to authenticated, service_role;
