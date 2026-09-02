-- ============================================================
-- ⚠️ MIGRATION RECUPERADA DO DEV, NAO ESCRITA AQUI (D-207).
--
-- Esta fatia NAO e de quem a commitou. Ela foi aplicada ao Supabase Dev por
-- OUTRA FRENTE de trabalho em 02/09/2026 e nunca chegou ao repositorio. O SQL
-- abaixo foi recuperado, palavra por palavra, de
-- `supabase_migrations.schema_migrations.statements` — o unico lugar onde ele
-- existia. So este cabecalho de comentario foi acrescentado.
--
-- POR QUE RECUPERAR EM VEZ DE ESPERAR. Enquanto a versao `20260902005023`
-- estivesse no historico remoto e ausente daqui, `supabase db push` recusava
-- TUDO com "Remote migration versions not found in local migrations
-- directory" — e o job "aplicar migrations no Supabase Dev" ficou vermelho em
-- **todos** os commits de D-195 a D-206. Nao era a fatia de ninguem que
-- quebrava: era esta ausencia.
--
-- POR QUE NAO AS DUAS SAIDAS QUE O PROPRIO CLI SUGERE:
--
--   `supabase migration repair --status reverted 20260902005023`
--     Apaga a LINHA do historico e deixa a FUNCAO no banco. O Dev ficaria com
--     DDL que nenhuma migration explica, e o desalinhamento passaria de
--     barulhento a invisivel. Trocar um erro visivel por um silencioso e o
--     oposto do que a casa faz.
--
--   `supabase db pull`
--     Gera uma migration nova, com carimbo NOVO, a partir de um diff do
--     schema inteiro. A versao continuaria diferente da que esta no historico
--     remoto — o mesmo problema com outra roupa — e o diff arrastaria ruido
--     nao relacionado.
--
-- Recuperar com a versao e o nome EXATOS e a unica das tres que restaura o
-- invariante da casa: git e a memoria, e local == remoto.
--
-- QUANDO A OUTRA FRENTE EMPURRAR A DELA: o git vai acusar conflito neste
-- arquivo. O SQL sera identico (veio do banco); a diferenca sera este
-- cabecalho. **Fique com a versao deles** — ela tem a intencao original e o
-- registro da decisao. Este arquivo existe para destravar a esteira, nao para
-- reivindicar a fatia.
-- ============================================================

create or replace function public.get_stock_balances(
  p_organization_id uuid,
  p_supplier_brand text default null,
  p_category text default null,
  p_search text default null,
  p_only_negative boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  sku_id uuid, sku text, title text, local_quantity numeric, reservado numeric,
  transito numeric, full_quantity numeric, supplier_brand text, category text,
  purchase_cost numeric, created_at timestamptz, last_movement_at timestamptz,
  stock_is_virtual boolean, stock_is_virtual_set_at timestamptz, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  with pivot as (
    select b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL')     as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO')  as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
    group by b.sku_id
  ),
  base as (
    select p.sku_id, sk.sku, sk.title,
      coalesce(p.local_quantity, 0) as local_quantity,
      coalesce(p.reservado, 0) as reservado,
      coalesce(p.transito, 0) as transito,
      sk.supplier_brand,
      coalesce(sk.category_raw, sk.brand) as category,
      sk.purchase_cost, sk.created_at,
      sk.stock_is_virtual, sk.stock_is_virtual_set_at
    from pivot p
    join public.skus sk on sk.id = p.sku_id
    where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_category is null or coalesce(sk.category_raw, sk.brand) = p_category)
      and (p_search is null
           or sk.sku   ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
      and (not p_only_negative or coalesce(p.local_quantity, 0) < 0)
  ),
  pagina as (
    select b.*, count(*) over () as total_count
    from base b
    order by b.sku
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    pg.sku_id, pg.sku, pg.title, pg.local_quantity, pg.reservado, pg.transito,
    fp.full_quantity, pg.supplier_brand, pg.category, pg.purchase_cost,
    pg.created_at, um.last_movement_at, pg.stock_is_virtual,
    pg.stock_is_virtual_set_at, pg.total_count
  from pagina pg
  left join lateral (
    select m.occurred_at as last_movement_at
    from public.stock_movements m
    where m.organization_id = p_organization_id
      and m.sku_id = pg.sku_id
    order by m.occurred_at desc
    limit 1
  ) um on true
  left join lateral (
    select sum(q.quantity) as full_quantity
    from (
      select distinct on (f.ml_account_id, f.inventory_id) f.quantity
      from public.fulfillment_stock_snapshots f
      where f.organization_id = p_organization_id
        and f.sku_id = pg.sku_id
        and f.captured_at >= now() - interval '3 days'
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) q
  ) fp on true
  order by pg.sku
$$;

comment on function public.get_stock_balances(uuid, text, text, text, boolean, integer, integer) is
  'Estoque enriquecido (D-139): saldo pivotado LOCAL/RESERVADO/TRANSITO mais Full, marca real do fornecedor, categoria, custo, data de criacao e ultimo movimento, com filtros e janela. Page-first (D-196): Full e ultimo movimento sao calculados por lateral SOMENTE para os SKUs da pagina -- nenhum dos dois filtra ou ordena, entao calcula-los antes do limit lia 313.941 linhas para enriquecer 50. Full na definicao canonica de D-173 (ultimo snapshot por bucket inventory_id, janela de frescor de 3 dias), verificada linha a linha contra a definicao anterior: zero divergencias. NAO devolve valor de estoque: 1.089 SKUs carregam a assinatura sentinela e ZERO estao classificados (docs/METRICS.md 5C.4). Nao expoe origem nacional/importado: is_imported e origin_code sao fiscais e contradizem a rota de compra (D-129).';

revoke all on function public.get_stock_balances(uuid, text, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.get_stock_balances(uuid, text, text, text, boolean, integer, integer) to authenticated, service_role;
