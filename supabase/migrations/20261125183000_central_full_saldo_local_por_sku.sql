-- D-874: a Central Full busca o saldo local por SKU, e nao cruza a lista
-- inteira com cada linha.
--
-- `get_fulfillment_overview` agregava o estoque LOCAL numa CTE e juntava com o
-- Full por `left join`. O planner escolhia um laco aninhado que percorria a
-- lista agregada para cada linha do Full: em producao, como membro, 1,5 a 2,0 s,
-- quase todo o tempo nesse laco, com milhoes de pares descartados.
--
-- Como `inventory_balances` tem unicidade em (sku_id, location_kind), cada SKU
-- tem no maximo uma linha LOCAL. A subconsulta por linha usa esse indice:
-- 155 a 164 ms, no plano normal e no generico. Nos 12 recortes conferidos em
-- producao (ordens, foco, situacao, busca, conta, SKU, pagina 2, lista inteira
-- e busca vazia), as duas versoes devolveram as mesmas linhas na mesma ordem.
--
-- Mesma assinatura, mesmo retorno e mesmo corpo fora do saldo local.
-- `create or replace` preserva o comentario e os grants.

create or replace function public.get_fulfillment_overview(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_situation text default null,
  p_search text default null,
  p_sku_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0,
  -- D-380
  p_focus text default null,
  p_sort text default null,
  p_low_coverage_days integer default 15
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
  total_count bigint,
  facet_situation jsonb,
  -- D-380: venda media diaria da janela e quantos dias o Full dura nesse
  -- ritmo. NULL quando nao houve venda (cobertura infinita).
  daily_rate numeric,
  coverage_days numeric,
  facet_low_coverage bigint,
  facet_can_ship bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ultimo_bucket as materialized (
    -- O GRAO: um saldo por bucket do Mercado Livre. Colapsar por SKU aqui
    -- perderia as variacoes (246 pares tem mais de uma).
    --
    -- `as materialized` nao e enfeite: sem ele o planner reexecuta esta
    -- varredura para a contagem, e a funcao passa de 53 ms para 899 ms.
    --
    -- Ler por BUCKET tambem torna esta RPC imune a rodada pela metade: o
    -- job carimba `captured_at` uma vez no inicio e leva 5 a 6,5 minutos
    -- gravando as ~500 linhas (MEDIDO em 31/08: 312 a 395 s por rodada).
    -- Quem le `where captured_at = max(captured_at)` ve, nesses minutos,
    -- so a fracao ja gravada; aqui um bucket ainda nao regravado
    -- simplesmente mantem a captura anterior.
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
  classificado as (
    select f.ml_account_id, a.label as account_label, f.sku_id, s.sku, s.title as sku_title,
           f.full_quantity, f.buckets, f.captured_at,
           -- Estoque fisico e da ORGANIZACAO, nao da conta (regra do PRD). Vem
           -- junto para responder "da para repor?", e a tela mostra em coluna
           -- separada: somar com o Full seria a "soma cega" que o item veta.
           -- D-874: busca por SKU pelo indice unico (sku_id, location_kind). Com o
           -- saldo agregado numa CTE, o planner cruzava a lista inteira com cada
           -- linha do Full (1,5 a 2,0 s contra 155 a 164 ms em producao).
           coalesce((
             select sum(b.quantity)
             from public.inventory_balances b
             where b.organization_id = p_organization_id
               and b.location_kind = 'LOCAL'
               and b.sku_id = f.sku_id
           ), 0) as local_quantity,
           coalesce(v.units_sold, 0)::bigint as units_sold,
           -- Criterios DETERMINISTICOS e visiveis, sem score inventado.
           case
             when f.full_quantity > 0 and coalesce(v.units_sold, 0) > 0 then 'saudavel'
             when f.full_quantity > 0 then 'parado'
             when coalesce(v.units_sold, 0) > 0 then 'ruptura'
             else 'ausente'
           end as situation,
           -- D-380: media diaria sobre os dias da janela, nao sobre dias com
           -- venda -- a mesma janela que a coluna "Venda" mostra.
           case
             when coalesce(v.units_sold, 0) > 0
               then round(v.units_sold::numeric / greatest(p_date_to - p_date_from + 1, 1), 2)
           end as daily_rate,
           case
             when coalesce(v.units_sold, 0) > 0
               then round(
                 greatest(f.full_quantity, 0) * greatest(p_date_to - p_date_from + 1, 1) / v.units_sold::numeric,
                 1
               )
           end as coverage_days
    from full_por_sku f
    join public.ml_accounts a on a.id = f.ml_account_id
    join public.skus s on s.id = f.sku_id
    left join vendas v on v.ml_account_id = f.ml_account_id and v.sku_id = f.sku_id
    where p_search is null
       or s.sku ilike '%' || p_search || '%'
       or s.title ilike '%' || p_search || '%'
  ),
  base as (
    -- D-380: os dois recortes novos como colunas, para foco, facetas e
    -- ordem lerem a MESMA regra.
    select c.*,
           (c.full_quantity > 0 and c.coverage_days is not null
             and c.coverage_days < p_low_coverage_days) as acabando,
           ((c.situation = 'ruptura'
              or (c.full_quantity > 0 and c.coverage_days is not null and c.coverage_days < p_low_coverage_days))
             and c.local_quantity > 0) as enviavel
    from classificado c
  ),
  filtrado as (
    select * from base b
    where (p_situation is null or b.situation = p_situation)
      and (p_focus is null
           or (p_focus = 'acabando' and b.acabando)
           or (p_focus = 'enviavel' and b.enviavel))
  ),
  pagina as (
    select f.*,
           -- Janela sobre o conjunto FILTRADO inteiro: funcao de janela roda
           -- antes de ORDER BY/LIMIT no mesmo nivel, entao isto continua sendo
           -- o total da busca, nao o da pagina (D-131).
           count(*) over () as total_count,
           -- D-380: a ordem escolhida vira um numero, e o select final ordena
           -- por ele -- o `left join` da sentinela nao preserva ordem sozinho.
           row_number() over (
             order by
               case when p_sort = 'prioridade' then
                 case
                   when f.situation = 'ruptura' then 0
                   when f.acabando then 1
                   when f.situation = 'saudavel' then 2
                   when f.situation = 'parado' then 3
                   else 4
                 end
               end,
               case when p_sort = 'prioridade' and f.situation = 'ruptura' then f.units_sold end desc,
               case when p_sort in ('prioridade', 'cobertura') then f.coverage_days end asc nulls last,
               case when p_sort = 'vendas' then f.units_sold end desc,
               case when p_sort = 'local' then f.local_quantity end desc,
               case when p_sort = 'sku' then f.sku end,
               f.full_quantity desc, f.units_sold desc, f.sku, f.ml_account_id
           ) as ordem
    from filtrado f
  ),
  pagina_cortada as (
    select * from pagina p
    where p.ordem > greatest(p_offset, 0)
      and p.ordem <= greatest(p_offset, 0) + greatest(p_limit, 0)
  ),
  facetas as (
    -- Sobre `base`: depois de conta e busca, ANTES da situacao e do foco. Se
    -- seguisse o recorte, escolher "Ruptura" zeraria "Parado" e a faixa
    -- deixaria de dizer o que existe fora dele -- que e a unica coisa que ela
    -- tem para dizer, sendo navegacao.
    select coalesce(
             (select jsonb_object_agg(g.situation, g.n)
              from (select b.situation, count(*)::bigint as n from base b group by b.situation) g),
             '{}'::jsonb
           ) as facet_situation,
           (select count(*) from base b where b.acabando)::bigint as facet_low_coverage,
           (select count(*) from base b where b.enviavel)::bigint as facet_can_ship
  )
  select p.ml_account_id, p.account_label, p.sku_id, p.sku, p.sku_title,
         p.full_quantity, p.buckets, p.captured_at, p.local_quantity, p.units_sold, p.situation,
         coalesce(p.total_count, 0)::bigint,
         x.facet_situation,
         p.daily_rate, p.coverage_days,
         x.facet_low_coverage, x.facet_can_ship
  -- `facetas` ANTES, com `left join`: pagina vazia ainda devolve UMA linha,
  -- com as colunas do SKU em NULL, so para carregar as contagens da faixa.
  from facetas x
  left join pagina_cortada p on true
  order by p.ordem
$$;
