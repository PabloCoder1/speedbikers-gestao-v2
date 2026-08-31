-- Timeline de evidencias (D-153, Fase 6B): "domain_events ja e a linha do
-- tempo; falta a tela" (ROADMAP). A ordem dos acontecimentos de UM SKU,
-- juntando os tres caminhos de D-152 (evento do SKU; de ANUNCIO via
-- listings; de PEDIDO via order_items congelados) -- mas com o contrato
-- OPOSTO no vocabulario, e a diferenca e deliberada:
--
--   * a CORRELACAO (get_sku_correlated_events) fecha o vocabulario porque
--     causa candidata inventada e ruido vestido de causa -- e exclui
--     available_quantity.changed;
--   * a TIMELINE e HISTORIA, nao causa: todo evento mapeavel ao SKU entra,
--     inclusive as mudancas de quantidade -- elas SAO a historia do estoque
--     daquele SKU, e escolher o que entra na historia seria editar o
--     passado. A janela e limitada (p_limit) e a tela diz quanto mostra.
--
-- Devolve before/after para a tela formatar com formatEventDiff (que so
-- interpreta formatos documentados -- os demais aparecem sem diff, nunca
-- com leitura inventada) e o label da conta para dizer DE ONDE veio.
--
-- Guarda do cast de pedido identica a D-152.
--
-- EXPLAIN (ANALYZE, BUFFERS) 2026-08-31: 70 ms quente, 36.286 buffers para
-- o SKU MAIS MOVIMENTADO da organizacao (pior caso), limit 50. Nenhum
-- indice novo.

create function public.get_sku_timeline(
  p_organization_id uuid,
  p_sku_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  occurred_at timestamptz,
  event_type text,
  entity_type text,
  entity_id text,
  severity text,
  before jsonb,
  after jsonb,
  account_label text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with mapped as (
    select e.id, e.occurred_at, e.event_type, e.entity_type, e.entity_id,
           e.severity, e.before, e.after, e.ml_account_id
    from public.domain_events e
    where e.organization_id = p_organization_id
      and e.entity_type = 'sku'
      and e.entity_id = p_sku_id::text

    union all

    select e.id, e.occurred_at, e.event_type, e.entity_type, e.entity_id,
           e.severity, e.before, e.after, e.ml_account_id
    from public.domain_events e
    join public.listings l
      on l.ml_account_id = e.ml_account_id and l.item_id = e.entity_id
    where e.organization_id = p_organization_id
      and e.entity_type = 'listing'
      and l.sku_id = p_sku_id

    union all

    select distinct e.id, e.occurred_at, e.event_type, e.entity_type, e.entity_id,
           e.severity, e.before, e.after, e.ml_account_id
    from public.domain_events e
    join public.order_items oi
      on e.entity_id ~ '^[0-9]+$' and oi.order_id = e.entity_id::bigint
    where e.organization_id = p_organization_id
      and e.entity_type = 'order'
      and oi.sku_id = p_sku_id
  )
  select m.id, m.occurred_at, m.event_type, m.entity_type, m.entity_id,
         m.severity, m.before, m.after, a.label as account_label
  from mapped m
  left join public.ml_accounts a on a.id = m.ml_account_id
  order by m.occurred_at desc
  limit greatest(p_limit, 0)
$$;

comment on function public.get_sku_timeline(uuid, uuid, integer) is
  'Linha do tempo de UM SKU (D-153): todos os eventos mapeaveis a ele -- do proprio SKU, dos seus anuncios (listings por conta+item_id) e dos seus pedidos (order_items congelados, D-020) -- em ordem cronologica decrescente, com before/after para diff documentado e o label da conta. Contrato OPOSTO ao de get_sku_correlated_events no vocabulario, de proposito: correlacao fecha a lista (causa candidata inventada e ruido); timeline e HISTORIA e nao edita o passado. security invoker.';

revoke all on function public.get_sku_timeline(uuid, uuid, integer) from public, anon;
grant execute on function public.get_sku_timeline(uuid, uuid, integer) to authenticated, service_role;
