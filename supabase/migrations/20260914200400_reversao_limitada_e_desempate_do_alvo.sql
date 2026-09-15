-- D-351, verificacao de e6fda07 -- duas pecas de banco da segunda correcao.
--
-- 1. `compute_erp_target_balances` DESEMPATA a reimportacao (BAIXA-2 de corte-imported-at).
--    Desde D-351 o `captured_at` vem do NOME da planilha. Reimportar o mesmo arquivo
--    corrigido (o conteudo muda, e o `UNIQUE (organization_id, content_hash)` deixa entrar)
--    produz dois lotes com o MESMO `captured_at`, e o `distinct on (sku_id, warehouse)
--    order by captured_at desc` escolhia qualquer um dos dois: o alvo ficava com o lote
--    velho (provado na verificacao: 7, contra 6 da reimportacao). Antes de D-351 o
--    `captured_at` era o parse, e a reimportacao vencia sempre. O desempate por
--    `created_at desc, id desc` devolve isso, e e o mesmo que `get_erp_stock_cutoffs` usa
--    para achar o snapshot vencedor. Mesma assinatura, mesmo corpo fora do desempate, e os
--    mesmos grants: so `service_role`, desde 20260830004256.
--
-- 2. `get_order_return_movements`: as devolucoes gravadas de um lote de pedidos (ALTA-1 de
--    cancelamento-trio). Cancelamento e devolucao entregue revertem o MESMO VENDA_ML, e a
--    unidade volta ao estoque no maximo uma vez: antes de gravar uma das duas, o worker le a
--    outra. O cancelamento sai pela origem do pedido (`source_type = 'ORDER'`); a devolucao
--    e gravada com a origem do CLAIM, e o pedido so aparece DENTRO da chave
--    (`devolucao:<claim>:venda:<pedido>:<posicao>[:<componente>]`). Pelo PostgREST seria um
--    `like 'devolucao:%:venda:<pedido>:%'`, que nenhum indice atende; aqui o pedido e o
--    quarto campo da chave, com indice de expressao parcial. Formato conferido em
--    2026-09-15: nenhuma devolucao fora dele em producao (2) nem no Dev (580).

create or replace function public.compute_erp_target_balances(p_organization_id uuid)
returns table (
  sku_id uuid,
  location_kind text,
  quantity numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    -- Snapshot mais recente por (sku_id, warehouse) -- um lote reimportado
    -- nao soma com o anterior, substitui. So SKUs ja resolvidos. Com o mesmo
    -- `captured_at` (a mesma planilha reimportada), vence a linha gravada por
    -- ultimo (D-351).
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.reserved, s.captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc, s.created_at desc, s.id desc
  ),
  aggregated as (
    -- Soma entre armazens: o ledger da V3 nao distingue armazem do UpSeller.
    -- `captured_at` fica sendo o mais recente entre os armazens do SKU -- e o
    -- instante a partir do qual os nossos movimentos passam a valer.
    select
      l.sku_id,
      sum(l.available) as available,
      sum(l.reserved) as reserved,
      max(l.captured_at) as captured_at
    from latest l
    group by l.sku_id
  ),
  depois as (
    select
      a.sku_id,
      m.location_kind,
      sum(m.qty_delta) as delta
    from aggregated a
    join public.stock_movements m
      on m.sku_id = a.sku_id
     and m.organization_id = p_organization_id
     and m.occurred_at > a.captured_at
     and m.movement_type <> 'AJUSTE_RECONCILIACAO'
    group by a.sku_id, m.location_kind
  )
  select
    a.sku_id,
    'LOCAL'::text as location_kind,
    a.available + coalesce(d.delta, 0) as quantity
  from aggregated a
  left join depois d on d.sku_id = a.sku_id and d.location_kind = 'LOCAL'
  union all
  select
    a.sku_id,
    'RESERVADO'::text as location_kind,
    a.reserved + coalesce(d.delta, 0) as quantity
  from aggregated a
  left join depois d on d.sku_id = a.sku_id and d.location_kind = 'RESERVADO'
$$;

comment on function public.compute_erp_target_balances(uuid) is
  'Saldo-ALVO por SKU: o snapshot do UpSeller rolado para a frente pelos movimentos posteriores a captura (D-132). AJUSTE_RECONCILIACAO e excluido da soma de proposito: ajuste nao e evento de estoque, e correcao em direcao ao alvo -- inclui-lo tornaria a funcao circular. Com o mesmo captured_at em dois lotes (a planilha reimportada), vence a linha gravada por ultimo (D-351).';

revoke all on function public.compute_erp_target_balances(uuid) from public, anon, authenticated;
grant execute on function public.compute_erp_target_balances(uuid) to service_role;

create function public.get_order_return_movements(p_organization_id uuid, p_order_ids text[])
returns table (order_id text, sku_id uuid, qty_delta numeric, idempotency_key text)
language sql
stable
security invoker
set search_path = ''
as $$
  select split_part(m.idempotency_key, ':', 4) as order_id,
         m.sku_id,
         m.qty_delta,
         m.idempotency_key
  from public.stock_movements m
  where m.organization_id = p_organization_id
    and m.movement_type = 'DEVOLUCAO_ML'
    and split_part(m.idempotency_key, ':', 4) = any(p_order_ids)
$$;

comment on function public.get_order_return_movements(uuid, text[]) is
  'DEVOLUCAO_ML gravadas dos pedidos pedidos, pelo pedido de dentro da chave (devolucao:<claim>:venda:<pedido>:...). O worker as le antes de gravar um cancelamento ou uma devolucao: a unidade vendida volta ao estoque no maximo uma vez (D-351).';

revoke all on function public.get_order_return_movements(uuid, text[]) from public, anon, authenticated;
grant execute on function public.get_order_return_movements(uuid, text[]) to service_role;

create index stock_movements_devolucao_pedido_idx
  on public.stock_movements (organization_id, (split_part(idempotency_key, ':', 4)))
  where movement_type = 'DEVOLUCAO_ML';
