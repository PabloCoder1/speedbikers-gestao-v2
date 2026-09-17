-- ============================================================
-- /fornecedores refeita (D-366): UMA leitura com busca, recortes que
-- respondem "com quem tenho pedido em aberto?", ordenacao e o resumo da base.
--
-- `get_suppliers` (D-258) continua existindo e igual: a suite de integracao a
-- chama, e ela e a referencia contra a qual esta funcao e conferida. A tela
-- passa a ler so esta.
--
-- ------------------------------------------------------------
-- O QUE A LISTA NAO RESPONDIA
-- ------------------------------------------------------------
--   * nao havia busca -- achar um fornecedor era rolar a pagina;
--   * o unico recorte era ativo/inativo; "com quem ha pedido EM ABERTO" (o
--     que a compra acompanha no dia a dia) nao existia;
--   * a ordem era so por nome: "quem mais compro" e "com quem comprei por
--     ultimo" nao tinham como aparecer primeiro;
--   * nada resumia a base: quanto esta em aberto, quanto foi comprado.
--
-- ------------------------------------------------------------
-- POR QUE NAO E PAGE-FIRST (a excecao a D-196, e o limite dela)
-- ------------------------------------------------------------
-- `get_suppliers` agrega DEPOIS do limit porque so ordena por nome. Aqui a
-- ordem pode ser por valor ou pelo ultimo pedido, e os cartoes contam o
-- conjunto inteiro -- as duas coisas exigem o agregado de TODOS os
-- fornecedores da busca. O custo e limitado pela natureza do dado: fornecedor
-- e cadastro humano (dezenas a centenas por organizacao, nao milhares), e os
-- agregados sao dois `group by` sobre os pedidos da organizacao, que usam
-- `purchase_orders_org_status_idx`.
--
-- ------------------------------------------------------------
-- AS MESMAS DEFINICOES DE D-258, e as novas
-- ------------------------------------------------------------
-- valor_pedido      exclui CANCELLED; tres saidas: 0 sem item (zero sabido),
--                   NULL com itens e nenhum custo, soma parcial com
--                   itens_sem_custo > 0. Identica a `get_suppliers`.
-- em aberto         DRAFT, APPROVED e ORDERED -- o que ainda nao terminou.
--                   Mesmo recorte da gaveta (`inspecao-fornecedor.tsx`).
-- valor_em_aberto   as mesmas tres saidas, sobre os itens dos pedidos em
--                   aberto.
-- sem_pedido        nenhum pedido em estado nenhum, cancelado incluido: quem
--                   teve pedido cancelado ja teve relacionamento.
--
-- O resumo (`totais`) usa o conjunto da BUSCA, sem o recorte de estado -- os
-- cartoes precisam dos outros recortes quando um deles esta ativo (D-250),
-- o mesmo desenho de `get_replenishment_overview`.
-- ============================================================

create function public.get_suppliers_overview(
  p_organization_id uuid,
  p_search text default null,
  p_state text default null,
  p_order text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  termo text := nullif(btrim(coalesce(p_search, '')), '');
  -- CNPJ se digita com e sem pontuacao; o cadastro tambem guarda dos dois
  -- jeitos. So compara digitos quando o termo TEM digitos suficientes, senao
  -- "a" casaria com todo documento.
  digitos text := nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '');
  resultado jsonb;
begin
  with pedidos as (
    select po.supplier_id,
           count(*)::bigint as orders_total,
           count(*) filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED'))::bigint as orders_em_aberto,
           max(po.created_at) as ultimo_pedido_em
    from public.purchase_orders po
    where po.organization_id = p_organization_id
      and po.supplier_id is not null
    group by po.supplier_id
  ),
  itens as (
    select po.supplier_id,
           count(*) filter (where po.status <> 'CANCELLED') as itens_validos,
           round(sum(i.quantity_ordered * i.unit_cost) filter (where po.status <> 'CANCELLED'), 2) as soma_valida,
           count(*) filter (where po.status <> 'CANCELLED' and i.unit_cost is null)::bigint as itens_sem_custo,
           count(*) filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED')) as itens_abertos,
           round(sum(i.quantity_ordered * i.unit_cost)
             filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED')), 2) as soma_aberta,
           count(*) filter (where po.status in ('DRAFT', 'APPROVED', 'ORDERED')
                              and i.unit_cost is null)::bigint as itens_em_aberto_sem_custo,
           -- Com os cancelados, como `get_supplier_overview`: o mesmo nome
           -- tem de contar a mesma coisa na lista e no dashboard.
           count(distinct coalesce(i.sku_id::text, i.sku_snapshot))::bigint as skus_distintos
    from public.purchase_order_items i
    join public.purchase_orders po on po.id = i.purchase_order_id
    where po.organization_id = p_organization_id
      and po.supplier_id is not null
    group by po.supplier_id
  ),
  base as (
    select s.id, s.name, s.legal_name, s.document, s.contact_name, s.email,
           s.phone, s.whatsapp, s.website, s.is_active, s.created_at,
           coalesce(p.orders_total, 0) as orders_total,
           coalesce(p.orders_em_aberto, 0) as orders_em_aberto,
           p.ultimo_pedido_em,
           -- As tres saidas de D-258: sem item -> 0; itens sem custo -> NULL.
           case when coalesce(it.itens_validos, 0) = 0 then 0 else it.soma_valida end as valor_pedido,
           coalesce(it.itens_sem_custo, 0) as itens_sem_custo,
           case when coalesce(it.itens_abertos, 0) = 0 then 0 else it.soma_aberta end as valor_em_aberto,
           coalesce(it.itens_em_aberto_sem_custo, 0) as itens_em_aberto_sem_custo,
           coalesce(it.skus_distintos, 0) as skus_distintos
    from public.suppliers s
    left join pedidos p on p.supplier_id = s.id
    left join itens it on it.supplier_id = s.id
    where s.organization_id = p_organization_id
      and (termo is null
           or s.name ilike '%' || termo || '%'
           or s.legal_name ilike '%' || termo || '%'
           or s.contact_name ilike '%' || termo || '%'
           or s.email ilike '%' || termo || '%'
           or (length(digitos) >= 3
               and regexp_replace(coalesce(s.document, ''), '\D', '', 'g') like '%' || digitos || '%'))
  ),
  filtrada as (
    select b.*
    from base b
    where p_state is null
       or (p_state = 'ativos' and b.is_active)
       or (p_state = 'inativos' and not b.is_active)
       or (p_state = 'em_aberto' and b.orders_em_aberto > 0)
       or (p_state = 'sem_pedido' and b.orders_total = 0)
  ),
  pagina as (
    select f.*
    from filtrada f
    order by
      case when p_order = 'valor' then f.valor_pedido end desc nulls last,
      case when p_order = 'recente' then f.ultimo_pedido_em end desc nulls last,
      case when p_order = 'em_aberto' then f.orders_em_aberto end desc,
      lower(f.name), f.id
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'contagens', (
      select jsonb_build_object(
        'todos', count(*),
        'ativos', count(*) filter (where b.is_active),
        'inativos', count(*) filter (where not b.is_active),
        'em_aberto', count(*) filter (where b.orders_em_aberto > 0),
        'sem_pedido', count(*) filter (where b.orders_total = 0))
      from base b),
    'totais', (
      select jsonb_build_object(
        'pedidos_em_aberto', coalesce(sum(b.orders_em_aberto), 0),
        -- A soma das somas repete as tres saidas: se ha item em aberto e
        -- NENHUM tem custo, o total e desconhecido, nao R$ 0,00.
        'valor_em_aberto', case
          when coalesce(sum(it.itens_abertos), 0) = 0 then 0
          else round(sum(it.soma_aberta), 2) end,
        'itens_em_aberto_sem_custo', coalesce(sum(b.itens_em_aberto_sem_custo), 0),
        'valor_comprado', case
          when coalesce(sum(it.itens_validos), 0) = 0 then 0
          else round(sum(it.soma_valida), 2) end,
        'itens_sem_custo', coalesce(sum(b.itens_sem_custo), 0),
        'ultimo_pedido_em', max(b.ultimo_pedido_em),
        'ultimo_pedido_fornecedor', (
          select b2.name from base b2
          where b2.ultimo_pedido_em is not null
          order by b2.ultimo_pedido_em desc, b2.name
          limit 1))
      from base b
      left join itens it on it.supplier_id = b.id),
    'linhas', coalesce((
      select jsonb_agg(to_jsonb(p) order by
        case when p_order = 'valor' then p.valor_pedido end desc nulls last,
        case when p_order = 'recente' then p.ultimo_pedido_em end desc nulls last,
        case when p_order = 'em_aberto' then p.orders_em_aberto end desc,
        lower(p.name), p.id)
      from pagina p), '[]'::jsonb)
  )
  into resultado;

  return resultado;
end
$fn$;

comment on function public.get_suppliers_overview(uuid, text, text, text, integer, integer) is
  'Lista de /fornecedores refeita (D-366): pagina + total filtrado + contagens por recorte (todos, ativos, inativos, em_aberto, sem_pedido) + totais da base (em aberto e comprado, com as tres saidas de D-258: 0 sem item, NULL com itens e nenhum custo, parcial com itens_sem_custo > 0). Busca em nome, razao social, contato, e-mail e digitos do documento. p_order: null/nome, valor, recente, em_aberto. Contagens e totais usam o conjunto da busca SEM o recorte (D-250). Agrega todos os fornecedores da busca (nao page-first): a ordem por valor/ultimo pedido exige, e fornecedor e cadastro humano de ordem de centenas. security invoker.';

revoke all on function public.get_suppliers_overview(uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_suppliers_overview(uuid, text, text, text, integer, integer) to authenticated, service_role;
