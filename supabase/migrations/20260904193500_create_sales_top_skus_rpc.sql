-- ============================================================
-- Os produtos que mais contribuiram no periodo (D-244) — a tabela que fecha o
-- frame `Sales` do Figma e que `/vendas` nao tinha.
--
-- O frame termina em `<DataTable title="Produtos que mais contribuiram" />`
-- (App.tsx:1258). A auditoria de fidelidade classificou a ausencia como P0
-- porque o dado EXISTE: `daily_sku_metrics` guarda receita, unidades, pedidos
-- e compras por (conta, SKU, dia) — e o ranking e uma soma por SKU ordenada,
-- feita aqui e nao no navegador (docs/ARCHITECTURE.md secao 15).
--
-- Mesmos argumentos e MESMO recorte de marca de `get_sales_summary`, para a
-- tabela responder ao mesmo filtro da faixa acima dela:
--   - `p_supplier_brand`: SKUs cuja `supplier_brand` e a marca;
--   - `p_sem_marca`: a venda que nenhuma marca alcanca — SKU sem marca
--     cadastrada. O bucket `sku_id IS NULL` (item vendido sem vinculo) fica de
--     FORA desta tabela: nao ha produto para nomear numa linha, e somar tudo
--     numa linha "sem SKU" seria uma linha que nao e produto. O total desse
--     bucket continua visivel na faixa (`get_sales_summary`, que o inclui).
-- `p_order_by` escolhe a coluna do ranking: 'receita' (default), 'unidades',
-- 'pedidos' ou 'compras' — a mesma metrica que o segmentado do grafico. Valor
-- desconhecido cai em receita, nunca em zero linhas.
--
-- Razoes (ticket, preco medio) chegam calculadas sobre as SOMAS (nunca media
-- de medias) e NULAS com denominador zero. `share` e a fatia da receita do SKU
-- no total do MESMO recorte — um dado, um denominador.
--
-- Sem `p_organization_id`, como as demais RPCs de vendas: quem restringe e a
-- RLS de `daily_sku_metrics` (security invoker).
-- ============================================================

create function public.get_sales_top_skus(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false,
  p_order_by text default 'receita',
  p_limit integer default 10
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  supplier_brand text,
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  average_selling_price numeric,
  share numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    select m.sku_id, m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count
    from public.daily_sku_metrics m
    where m.sku_id is not null
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (
        case
          when p_sem_marca then
            not exists (select 1 from public.skus s
                        where s.id = m.sku_id and s.supplier_brand is not null)
          when p_supplier_brand is not null then
            exists (select 1 from public.skus s
                    where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
          else true
        end
      )
  ),
  por_sku as (
    select e.sku_id,
           sum(e.units_sold)::bigint      as units_sold,
           round(sum(e.gross_revenue), 2) as gross_revenue,
           sum(e.orders_count)::bigint    as orders_count,
           sum(e.purchases_count)::bigint as purchases_count
    from escopo e
    group by e.sku_id
  ),
  total as (
    select nullif(sum(p.gross_revenue), 0) as gross_revenue from por_sku p
  )
  select
    p.sku_id,
    s.sku,
    s.title,
    s.supplier_brand,
    p.units_sold,
    p.gross_revenue,
    p.orders_count,
    p.purchases_count,
    round(p.gross_revenue / nullif(p.units_sold, 0), 2) as average_selling_price,
    round(p.gross_revenue / t.gross_revenue, 4) as share
  from por_sku p
  join public.skus s on s.id = p.sku_id
  cross join total t
  order by
    case p_order_by
      when 'unidades' then p.units_sold
      when 'pedidos'  then p.orders_count
      when 'compras'  then p.purchases_count
      else null
    end desc nulls last,
    p.gross_revenue desc,
    s.sku asc
  limit greatest(p_limit, 0)
$$;

comment on function public.get_sales_top_skus(date, date, uuid, text, boolean, text, integer) is
  'Produtos que mais contribuiram no periodo (D-244): soma por SKU de daily_sku_metrics, ordenada pela metrica escolhida (receita default, unidades, pedidos, compras), com o MESMO recorte de conta e marca de get_sales_summary. Itens vendidos sem vinculo de SKU ficam de fora (nao ha produto a nomear); razoes sobre as somas, nulas com denominador zero; share = receita do SKU / receita do recorte.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova (D-182/D-242): revogar
-- ANTES do grant, senao `anon` alcanca a RPC.
revoke execute on function public.get_sales_top_skus(date, date, uuid, text, boolean, text, integer) from public, anon;
grant execute on function public.get_sales_top_skus(date, date, uuid, text, boolean, text, integer) to authenticated, service_role;
