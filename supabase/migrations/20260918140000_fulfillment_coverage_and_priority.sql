-- ============================================================
-- `get_fulfillment_overview` ganha COBERTURA, FOCO e ORDEM (D-380).
--
-- ------------------------------------------------------------
-- O QUE A TELA NAO CONSEGUIA DIZER
-- ------------------------------------------------------------
-- As quatro situacoes de D-265 respondem "tem ou nao tem no Full", e so. Em
-- producao (SELECT de 2026-09-18, 4 contas, janela de 30 dias): dos 537 SKUs
-- "saudaveis", **205 acabam em menos de 15 dias** no ritmo da janela e 76 em
-- menos de 7. Para o operador, esses sao os primeiros da fila de envio, e a
-- tela os pintava de verde.
--
-- Cobertura aqui e aritmetica DECLARADA, nao previsao: saldo no Full dividido
-- pela venda media diaria da MESMA janela da coluna "Venda". Nao ha sazonalidade,
-- tendencia nem score -- a mesma recusa de D-265 continua valendo. Sem venda
-- na janela, cobertura e NULL (infinita), nunca um numero grande inventado.
--
-- ------------------------------------------------------------
-- TRES PARAMETROS NOVOS, todos com default -- os tres chamadores seguem iguais
-- ------------------------------------------------------------
-- * `p_low_coverage_days` (15): o limiar de "acabando". Vai como parametro
--   porque a tela precisa ESCREVER o numero que usa, e ele nao pode morar
--   em dois lugares com valores diferentes.
-- * `p_focus`: `acabando` (tem Full, vende, cobertura abaixo do limiar) ou
--   `enviavel` (ruptura ou acabando E com saldo LOCAL > 0 -- da para mandar
--   hoje). Recorte que so o SQL pode fazer, porque a pagina e de 50 linhas.
-- * `p_sort`: `prioridade`, `cobertura`, `vendas`, `local`, `sku`; NULL
--   mantem a ordem antiga (Full desc), que e o que `/skus` e `/anuncios` usam.
--
-- `/skus/[skuId]` e `/anuncios/[itemId]` chamam por NOME de argumento e sem os
-- novos -- continuam resolvendo para esta funcao pelos defaults. A web que
-- estiver no ar ANTES do deploy desta fatia tambem: so colunas foram
-- ACRESCENTADAS ao retorno.
--
-- ------------------------------------------------------------
-- DUAS FACETAS NOVAS, sobre `base` como a de situacao
-- ------------------------------------------------------------
-- `facet_low_coverage` e `facet_can_ship` contam depois de conta e busca e
-- ANTES de situacao e foco, pelo mesmo motivo de D-265: sao navegacao, e
-- escolher um recorte nao pode zerar o caminho para o outro. Viajam na
-- linha-sentinela junto com `facet_situation`.
--
-- ------------------------------------------------------------
-- O QUE NAO MUDOU
-- ------------------------------------------------------------
-- O GRAO (`distinct on (ml_account_id, inventory_id)`, D-173), o
-- `as materialized` (53 ms contra 899 ms), a janela de 3 dias de captura, o
-- criterio das quatro situacoes e a linha-sentinela. O corpo abaixo foi
-- EXTRAIDO de 20260908210000, nao redigitado (licao de D-259); as mudancas
-- sao os blocos marcados com D-380.
-- ============================================================

drop function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer);

create function public.get_fulfillment_overview(
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
  saldo_local as (
    -- Estoque fisico e da ORGANIZACAO, nao da conta (regra do PRD). Vem
    -- junto para responder "da para repor?", e a tela mostra em coluna
    -- separada: somar com o Full seria a "soma cega" que o item veta.
    select b.sku_id, sum(b.quantity) as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id and b.location_kind = 'LOCAL'
    group by b.sku_id
  ),
  classificado as (
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
    left join saldo_local l on l.sku_id = f.sku_id
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

comment on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer, text, text, integer) is
  'Central Full por conta e SKU (D-173; p_sku_id desde D-224; facet_situation desde D-265; cobertura, foco e ordem desde D-380). O GRAO e por BUCKET (ml_account_id, inventory_id) e nao se colapsa por (sku, conta): D-173 mediu 15,6% de unidades a menos assim. `as materialized` em ultimo_bucket evita o planner reexecutar a varredura para a contagem (53 ms contra 899 ms). Le so capturas dos ultimos 3 dias. coverage_days = Full / venda media diaria da janela, NULL sem venda -- aritmetica declarada, sem previsao. p_focus: acabando | enviavel; p_sort: prioridade | cobertura | vendas | local | sku (NULL = Full desc, a ordem antiga). As facetas contam sobre `base` (depois de conta e busca, ANTES de situacao e foco) porque a faixa e NAVEGACAO. Ha LINHA-SENTINELA: pagina vazia devolve uma linha com as colunas do SKU em NULL -- os tres chamadores descartam por sku_id is null. security invoker.';

revoke all on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer, text, text, integer) from public, anon;
grant execute on function public.get_fulfillment_overview(uuid, date, date, uuid, text, text, uuid, integer, integer, text, text, integer) to authenticated, service_role;
