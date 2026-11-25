-- D-872: a faixa de /estoque deixa de levar ~2 s no plano generico.
--
-- `get_stock_summary` e `language sql` com `set search_path = ''`, entao o
-- Postgres nao a expande dentro da consulta que a chama: ela roda com o plano
-- GENERICO dos parametros. Nesse plano, `local_confirmado` juntava `saldos`
-- de volta a `escopo` num laco aninhado que descartava ~9,6 milhoes de linhas
-- por chamada. Medido em producao em 25/11, como membro autenticado: 1,7 a
-- 2,1 s por chamada, contra 154 ms do mesmo SQL escrito por extenso.
--
-- A reescrita leva as colunas do SKU dentro de `saldos` (nenhuma juncao nova)
-- e restringe o Full com `sku_id in (select id from escopo)`. Sob o plano
-- generico forcado, 3,2 s cairam para 296 ms. Nos 7 recortes conferidos em
-- producao (sem filtro, negativos, marca, categoria, busca, busca vazia e
-- marca com negativos), as duas versoes devolveram a mesma linha.
--
-- Mesma assinatura, mesmo retorno e a mesma regra do Full desconhecido (D-870).

create or replace function public.get_stock_summary(
  p_organization_id uuid,
  p_supplier_brand text default null,
  p_category text default null,
  p_search text default null,
  p_only_negative boolean default false
)
returns table (
  skus_no_recorte bigint,
  skus_confirmados_fisicos bigint,
  skus_nao_classificados bigint,
  unidades_local numeric,
  valor_estimado numeric,
  reservado numeric,
  transito numeric,
  transito_tem_registro boolean,
  full_quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    -- Mesmo recorte de `get_stock_balances`, para faixa e tabela nunca
    -- falarem de conjuntos diferentes.
    select sk.id, sk.purchase_cost, sk.stock_is_virtual, sk.stock_is_virtual_set_at
    from public.skus sk
    where sk.organization_id = p_organization_id
      and (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_category is null or coalesce(sk.category_raw, sk.brand) = p_category)
      and (p_search is null
           or sk.sku ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
  ),
  saldos as (
    -- As colunas do SKU vem junto (D-872): `local_confirmado` nao precisa
    -- juntar `escopo` de novo.
    select b.sku_id, b.location_kind, b.quantity, e.purchase_cost, e.stock_is_virtual, e.stock_is_virtual_set_at
    from public.inventory_balances b
    join escopo e on e.id = b.sku_id
    where b.organization_id = p_organization_id
  ),
  local_confirmado as (
    -- SO o que foi CLASSIFICADO como fisico por gente. Ver secao 1: hoje sao
    -- zero SKUs, e a tela diz isso em vez de somar sentinela.
    select coalesce(sum(s.quantity), 0) as unidades,
           coalesce(sum(s.quantity * s.purchase_cost), 0) as valor
    from saldos s
    where s.location_kind = 'LOCAL'
      and s.stock_is_virtual_set_at is not null
      and not s.stock_is_virtual
  ),
  full_atual as (
    -- Definicao canonica: ultima captura por bucket, janela de 3 dias.
    -- Sem NENHUMA captura da organizacao na janela, o Full e desconhecido
    -- (nulo), nao zero (D-870). Com captura, o SKU do recorte que nao
    -- aparece nela esta fora do Full, e ai a soma vazia e zero de verdade.
    select case
             when exists (select 1 from public.fulfillment_stock_snapshots c
                          where c.organization_id = p_organization_id
                            and c.captured_at >= now() - interval '3 days')
             then coalesce(sum(x.quantity), 0)
           end as quantidade
    from (
      select distinct on (f.ml_account_id, f.inventory_id) f.quantity
      from public.fulfillment_stock_snapshots f
      where f.organization_id = p_organization_id
        and f.sku_id in (select id from escopo)
        and f.captured_at >= now() - interval '3 days'
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) x
  )
  select
    (select count(*) from escopo)::bigint,
    (select count(*) from escopo where stock_is_virtual_set_at is not null and not stock_is_virtual)::bigint,
    (select count(*) from escopo where stock_is_virtual_set_at is null)::bigint,
    lc.unidades,
    round(lc.valor, 2),
    (select coalesce(sum(quantity), 0) from saldos where location_kind = 'RESERVADO'),
    (select coalesce(sum(quantity), 0) from saldos where location_kind = 'TRANSITO'),
    -- Ausencia estrutural, nao saldo zero: distingue "nada em transito hoje"
    -- de "nenhum caminho escreve transito".
    (select exists (select 1 from public.stock_movements m
                    where m.organization_id = p_organization_id and m.location_kind = 'TRANSITO')),
    fa.quantidade
  from local_confirmado lc, full_atual fa
$$;

comment on function public.get_stock_summary(uuid, text, text, text, boolean) is
  'Faixa de KPIs de /estoque (D-249). Recebe os MESMOS filtros de get_stock_balances -- faixa e tabela nunca falam de conjuntos diferentes (licao de D-236). `unidades_local` e `valor_estimado` somam SO os SKUs que um humano confirmou como fisicos (stock_is_virtual_set_at is not null). `transito_tem_registro` distingue ausencia estrutural de saldo zero. Full pela definicao canonica (ultima captura por bucket em 3 dias); nulo quando a organizacao nao tem captura nenhuma na janela (D-870). Ruptura NAO entra: dono canonico e get_stock_coverage_summary. security invoker.';
