-- ============================================================
-- `get_sales_expanded_summary` lia `orders` DUAS vezes. Passa a ler uma
-- (D-306).
--
-- ------------------------------------------------------------
-- O QUE ESTA FATIA **NAO** E, e isto importa mais que o ganho
-- ------------------------------------------------------------
--
-- D-305 nomeou esta funcao numa lista de RPCs lentas e disse que o plano
-- generico explicava a lentidao delas. **Medido depois, aqui: nao explica.**
--
-- Oito execucoes consecutivas como `authenticated`, janela de 30 dias:
--
--     1868 ms (fria), 186, 221, 201, 200, 173, 171, 172
--
-- A **sexta** -- que e onde o plancache troca para o generico, e onde
-- `get_listings_dashboard` saltava de 200 ms para dezenas de segundos --
-- custou 173 ms. **Esta funcao nao tem a doenca de D-305**, e converte-la
-- para `plpgsql` + `force_custom_plan` teria sido remedio para doenca que ela
-- nao tem. O `language sql` fica.
--
-- O tempo dela cresce LINEARMENTE com a janela, que e o que uma consulta
-- honesta faz:
--
--     7d    67 ms      90d   415 ms
--     30d  179 ms     180d   824 ms
--     60d  313 ms     365d  1458 ms
--
-- Os 7.416 ms que `pg_stat_statements` registrou como pior caso sao
-- compativeis com **cache frio**: a primeira execucao de 365 dias custou
-- 12.115 ms contra 1.458 ms quente. Cache frio nao e defeito de consulta, e
-- nao e o que esta migration conserta.
--
-- ------------------------------------------------------------
-- O QUE ELA CONSERTA, ENTAO
-- ------------------------------------------------------------
--
-- Uma ineficiencia real e mensuravel, achada no EXPLAIN: `fees` e `counts`
-- percorriam **a mesma janela de `orders`, cada uma por sua conta**. Em 365
-- dias isso e 317.185 buffers cada, de 647.414 no total -- 98% do custo eram
-- as duas leituras da mesma coisa.
--
-- `pedidos` passa a ser UMA passada, materializada (o Postgres ja
-- materializaria: a CTE tem dois consumidores; o `materialized` explicito diz
-- a intencao). E `count(distinct o.id)` vira `count(*)`, porque `pedidos` tem
-- uma linha por pedido -- e por WHERE sobre `orders`, sem join, e `id` e a
-- chave primaria. A distincao custava um **sort externo de 11 MB** em disco.
--
-- MEDIDO, sempre como `authenticated` real com RLS ligada:
--
--     buffers (365d)      647.414  ->  330.423     -49%
--     sort externo         11 MB   ->  nenhum
--
--     tempo quente       atual      nova
--       7d                67 ms     50 ms
--      30d               179 ms    155 ms
--      90d               415 ms    358 ms
--     365d              1458 ms   1263 ms
--
-- Mais rapida em TODAS as janelas -- a verificacao existe porque
-- materializar podia ter piorado o caso pequeno, que e o comum.
--
-- ------------------------------------------------------------
-- QUE O RESULTADO NAO MUDA, CONFERIDO E NAO SUPOSTO
-- ------------------------------------------------------------
--
-- Oito cenarios, saida da funcao atual comparada com a nova, `is not distinct
-- from` (entao NULL conta como igual a NULL):
--
--     7d / 30d / 90d / 365d sem recorte      identicos
--     30d com marca 'OFF RACER'              identicos (com os NULLs do trio)
--     30d p_sem_marca                        identicos
--     30d com uma conta                      identicos
--     janela vazia                           identicos
--
-- Os NULLs do trio de cancelamento sob recorte sao o ponto sensivel do
-- contrato de D-237, e por isso ha caso para eles: `taxas_ml` e
-- `skus_distintos_vendidos` respondem por marca; `pedidos_cancelados`,
-- `taxa_cancelamento` e `valor_cancelado` voltam NULL, porque sao contagem
-- distinta e soma de `orders.total_amount`, do pedido inteiro, e nao existe
-- cota de marca.
--
-- ------------------------------------------------------------
-- A OUTRA FUNCAO DA LISTA, QUE FICOU COMO ESTAVA
-- ------------------------------------------------------------
--
-- `get_sku_correlated_events` foi medida na mesma sessao e **nao foi tocada**:
--
--     50 SKUs / 10 dias      520 ms fria, 44 ms quente
--    200 SKUs /  4 dias      133 ms
--   1000 SKUs /  4 dias       70 ms
--   3554 SKUs /  4 dias      428 ms   <- TODOS os SKUs, pior caso impossivel
--
-- Sem degradacao na sexta execucao, sem no caro no plano. Nao ha defeito para
-- consertar, e mexer numa funcao cujo pior caso medido e meio segundo seria
-- risco sem beneficio.
-- ============================================================

create or replace function public.get_sales_expanded_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  taxas_ml numeric,
  pedidos_cancelados bigint,
  taxa_cancelamento numeric,
  valor_cancelado numeric,
  skus_distintos_vendidos bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  recorte as (select (p_supplier_brand is null and not p_sem_marca) as sem_recorte),
  pedidos as materialized (
    -- UMA passada pela janela de `orders`. `fees` e `counts` liam esta mesma
    -- faixa cada uma por sua conta -- 317.185 buffers x 2 em 365 dias.
    select o.id, o.organization_id, o.ml_account_id, o.status, o.total_amount
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  fees as (
    select coalesce(round(sum(oi.sale_fee), 2), 0) as taxas_ml
    from pedidos p
    join public.order_items oi
      on oi.order_id = p.id
     and oi.organization_id = p.organization_id
     and oi.ml_account_id = p.ml_account_id
    where p.status in ('paid', 'partially_refunded')
      and ((p_supplier_brand is null and not p_sem_marca)
           or (case when p_sem_marca
                 then oi.sku_id is null
                      or not exists (select 1 from public.skus s
                                     where s.id = oi.sku_id and s.supplier_brand is not null)
                 else exists (select 1 from public.skus s
                              where s.id = oi.sku_id and s.supplier_brand = p_supplier_brand)
               end))
  ),
  counts as (
    -- `count(*)`, nao `count(distinct p.id)`: `pedidos` tem UMA linha por
    -- pedido -- e filtro sobre `orders`, sem join, e `id` e a chave primaria.
    -- A distincao forcava um sort externo de 11 MB em janela de 365 dias.
    select
      count(*) filter (where p.status in ('cancelled', 'pending_cancel')) as pedidos_cancelados,
      count(*) filter (where p.status in ('paid', 'partially_refunded')) as pedidos_validos,
      coalesce(round(sum(p.total_amount) filter (where p.status in ('cancelled', 'pending_cancel')), 2), 0) as valor_cancelado
    from pedidos p
  ),
  skus as (
    select count(distinct m.sku_id) as skus_distintos_vendidos
    from public.daily_sku_metrics m
    where m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
      and m.units_sold > 0
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and ((p_supplier_brand is null and not p_sem_marca)
           or (case when p_sem_marca
                 then not exists (select 1 from public.skus s
                                  where s.id = m.sku_id and s.supplier_brand is not null)
                 else exists (select 1 from public.skus s
                              where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
               end))
  )
  select
    fees.taxas_ml,
    case when r.sem_recorte then counts.pedidos_cancelados::bigint end as pedidos_cancelados,
    case when r.sem_recorte
         then round(counts.pedidos_cancelados::numeric / nullif(counts.pedidos_cancelados + counts.pedidos_validos, 0), 4) end as taxa_cancelamento,
    case when r.sem_recorte then counts.valor_cancelado end as valor_cancelado,
    skus.skus_distintos_vendidos::bigint
  from fees, counts, skus, recorte r
$$;

comment on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) is
  'Numeros expandidos de vendas (D-165; marca desde D-237; uma passada por orders desde D-306). taxas_ml e skus_distintos_vendidos aceitam recorte de marca -- o primeiro sai de order_items.sale_fee, o segundo e contagem distinta no grao SKU. O trio de cancelamento volta NULL sob recorte: sao contagem distinta e soma de orders.total_amount, do pedido inteiro, e nao ha cota de marca. D-306 fundiu as duas leituras de orders numa CTE materializada (-49% de buffers) e trocou count(distinct id) por count(*), que e equivalente porque a CTE tem uma linha por pedido -- a distincao custava um sort externo de 11 MB. security invoker.';

revoke all on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) to authenticated, service_role;
