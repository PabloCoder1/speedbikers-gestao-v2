-- ============================================================
-- RESOLVER CONFLITOS DE VINCULO POR SKU IDENTICO
-- ============================================================
--
-- Aplicada em producao como 20260818133547.
--
-- Dos 275 conflitos, 16 tinham exatamente UM candidato igual ao proprio
-- SKU do produto. Nao e ambiguidade real: BAU98 tinha candidatos
-- ATRT0311 e BAU98.
--
-- Regra espelhada de resolveExactSkuCandidate em stock-domain.ts, coberta
-- por teste. Exige exatamente um candidato identico: se dois normalizarem
-- para o mesmo SKU, a origem esta inconsistente e a decisao volta a ser
-- humana.
--
-- Guardas: so promove SKU que exista de fato no estoque fisico, e nunca
-- sobrescreve vinculo ativo existente.
--
-- Resultado medido: 12 dos 16 promovidos (4 barrados por nao existirem no
-- estoque), 126 unidades/30d passaram a ter vinculo, conflitos de 275
-- para 263. Reaproveita link_method 'exact_sku' e confidence 'exact', ja
-- usados pelo motor de vinculo.

with resolvable as (
  select
    conflict.id as conflict_id,
    conflict.organization_id,
    conflict.product_id,
    product.sku,
    product.sku_key,
    conflict.source_import_id,
    case
      when exists (
        select 1 from public.upseller_kits kit
        where kit.organization_id = conflict.organization_id
          and kit.kit_sku_key = product.sku_key
          and kit.is_current
      ) then 'kit'
      else 'simple'
    end as source_kind
  from public.product_inventory_link_conflicts as conflict
  join public.products as product
    on product.id = conflict.product_id
  where conflict.is_current
    and conflict.source = 'upseller'
    and (
      select count(*)
      from jsonb_array_elements_text(conflict.candidate_source_skus) as candidate
      where upper(btrim(candidate.value)) = product.sku_key
    ) = 1
    and exists (
      select 1 from public.upseller_stock_states state
      where state.organization_id = conflict.organization_id
        and state.sku_key = product.sku_key
    )
    and not exists (
      select 1 from public.product_inventory_links link
      where link.organization_id = conflict.organization_id
        and link.product_id = conflict.product_id
        and link.source = 'upseller'
        and link.is_active
    )
),
promoted as (
  insert into public.product_inventory_links (
    organization_id, product_id, source, source_sku, source_sku_key,
    source_kind, link_method, confidence, source_import_id, evidence, is_active
  )
  select
    resolvable.organization_id, resolvable.product_id, 'upseller',
    resolvable.sku, resolvable.sku_key, resolvable.source_kind,
    'exact_sku', 'exact', resolvable.source_import_id,
    jsonb_build_object(
      'rule', 'exact_sku_match',
      'resolvedConflictId', resolvable.conflict_id,
      'note', 'Um unico candidato identico ao SKU do produto.'
    ),
    true
  from resolvable
  returning product_id
)
update public.product_inventory_link_conflicts as conflict
set is_current = false, resolved_at = now()
from resolvable
where conflict.id = resolvable.conflict_id;
