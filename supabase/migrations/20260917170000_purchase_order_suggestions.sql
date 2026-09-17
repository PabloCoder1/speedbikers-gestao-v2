-- ============================================================
-- A sugestao da reposicao DENTRO do pedido de compra (D-371).
--
-- Pedido do dono, em /compras/novo:
--   * uma coluna "Sugestao" em cada item: escolhido o SKU, aparece quanto a
--     Cobertura e reposicao manda comprar dele;
--   * escolhido o fornecedor (que na pratica e a marca), trazer de uma vez os
--     itens a comprar daquela marca.
--
-- ------------------------------------------------------------
-- NENHUMA CONTA NOVA
-- ------------------------------------------------------------
-- Esta funcao so RECORTA `get_purchase_suggestions` (D-147/D-150, plano
-- custom desde D-358): a sugestao, o estado e a cobertura sao os da funcao
-- delegada, a mesma que /reposicao le -- e a integracao ja confere que ela e
-- identica a composicao de `@sb/domain`, SKU a SKU. Dois donos da mesma
-- sugestao seria o defeito de D-224.
--
-- ------------------------------------------------------------
-- POR QUE UMA FUNCAO, e nao a de /reposicao
-- ------------------------------------------------------------
-- `get_replenishment_overview` pagina e filtra por UM estado, e nao filtra
-- por lista de SKUs: a coluna "Sugestao" de um pedido com 30 itens colados
-- viraria 30 chamadas de ~250 ms, cada uma classificando o catalogo inteiro.
-- Aqui e UMA classificacao por chamada (~200 ms no Dev, D-358), para a lista
-- inteira de SKUs do pedido, ou para uma marca.
--
-- Dois recortes, e pelo menos um e obrigatorio -- sem nenhum a funcao
-- devolveria o catalogo inteiro, que nao e pergunta de pedido:
--   p_sku_ids         os SKUs que estao no pedido (a coluna Sugestao);
--   p_supplier_brand  a marca (o "trazer itens"), filtrada DENTRO da
--                     sugestao, que ja aceita marca.
-- `p_scope` so vale com marca: `comprar_agora` = ruptura + compra urgente;
-- `com_sugestao` = qualquer estado com sugestao positiva.
--
-- O aproveitavel sai com a mesma definicao do dominio (local + Full + transito
-- - reservado) e NULO para estoque virtual (D-127): ausencia nao e zero.
-- `is_imported` vem do cadastro, para o aviso de mistura de origem (D-151).
-- ============================================================

create function public.get_purchase_order_suggestions(
  p_organization_id uuid,
  p_sku_ids uuid[] default null,
  p_supplier_brand text default null,
  p_scope text default null,
  p_limit integer default 500,
  -- ULTIMO (convencao D-242/D-243). Nulo = hoje, como na sugestao (D-280); a
  -- tela nunca passa. Existe para a integracao, cujos dados vivem em 2025.
  p_date_to date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  marca text := nullif(btrim(coalesce(p_supplier_brand, '')), '');
  resultado jsonb;
begin
  if (p_sku_ids is null or cardinality(p_sku_ids) = 0) and marca is null then
    return jsonb_build_object('total', 0, 'linhas', '[]'::jsonb);
  end if;

  with sugestao as (
    select o.*
    from public.get_purchase_suggestions(
           p_organization_id, p_date_to, marca, null, 1000000, 0, null
         ) with ordinality as o(
           sku_id, sku, title, supplier_brand, purchase_cost, stock_is_virtual,
           local_quantity, reservado, transito, full_quantity,
           units_15d, units_30d, units_60d, units_90d, history_days_90,
           abc_class, coverage_days, state, suggested_quantity, total_count, ordem
         )
  ),
  recorte as (
    select s.*
    from sugestao s
    where (p_sku_ids is null or cardinality(p_sku_ids) = 0 or s.sku_id = any (p_sku_ids))
      and (marca is null
           or p_scope is null
           or (p_scope = 'comprar_agora' and s.state in ('RUPTURA', 'COMPRA_URGENTE') and s.suggested_quantity > 0)
           or (p_scope = 'com_sugestao' and s.suggested_quantity > 0))
  ),
  pagina as (
    select r.*
    from recorte r
    order by r.ordem
    limit greatest(least(coalesce(p_limit, 500), 500), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from recorte),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku_id', p.sku_id,
               'sku', p.sku,
               'title', p.title,
               'supplier_brand', p.supplier_brand,
               'purchase_cost', p.purchase_cost,
               'is_imported', k.is_imported,
               'state', p.state,
               'suggested_quantity', p.suggested_quantity,
               'coverage_days', p.coverage_days,
               'units_30d', p.units_30d,
               'aproveitavel', case when p.stock_is_virtual then null
                                    else p.local_quantity + p.full_quantity + p.transito - p.reservado end)
             order by p.ordem)
      from pagina p
      left join public.skus k on k.id = p.sku_id), '[]'::jsonb)
  )
  into resultado;

  return resultado;
end
$fn$;

comment on function public.get_purchase_order_suggestions(uuid, uuid[], text, text, integer, date) is
  'A sugestao da reposicao dentro do pedido de compra (D-371): recorte de get_purchase_suggestions (a mesma sugestao, estado e cobertura de /reposicao) por lista de SKUs (coluna Sugestao) e/ou por marca (trazer itens). Sem nenhum dos dois devolve vazio. p_scope, com marca: comprar_agora (ruptura + compra urgente com sugestao) ou com_sugestao (sugestao > 0). aproveitavel = local + Full + transito - reservado, NULO em estoque virtual. Ordem = prioridade de compra (D-150). Limite de 500 linhas, total antes do limite. security invoker.';

revoke all on function public.get_purchase_order_suggestions(uuid, uuid[], text, text, integer, date) from public, anon;
grant execute on function public.get_purchase_order_suggestions(uuid, uuid[], text, text, integer, date) to authenticated, service_role;
