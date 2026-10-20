-- D-495 (b) — A venda da Shopee baixa o estoque como a do Mercado Livre.
--
-- A regra mora em `packages/domain/src/inventory/shopee-sale-deduction.ts` e o
-- worker a aplica depois de cada lote da leitura de pedidos
-- (`apps/worker/src/handlers/shopee-stock.ts`), só nas lojas live. Aqui, só o
-- que o banco precisa:
--
--   * três tipos novos no ledger: `VENDA_SHOPEE` (a baixa, no instante do
--     pagamento), `CANCELAMENTO_SHOPEE` (o cancelamento depois do corte da
--     planilha, que repõe uma vez) e `ESTORNO_ARMAZEM_SHOPEE` (o par da venda que
--     saiu do armazém da Shopee, o equivalente ao `ESTORNO_FULL`). O estorno do
--     corte reaproveita o `ESTORNO_PRE_CAPTURA` (D-351): é a mesma causa;
--   * a origem é `SHOPEE_ORDER` com o `order_sn` (combinado com o A2), e o
--     extrato das movimentações devolve, no fim de cada linha, a loja e o dia do
--     pedido em São Paulo -- NULOS quando o pedido não existe.
--
-- O CHECK de `movement_type` é RECRIADO inteiro (a lista do último arquivo que o
-- recriou, 20260918000000_estorno_full_e_logistica_do_pedido.sql, mais os três), e `movement-type-check.test.ts` confere
-- que nenhum tipo gravado pelo código ficou de fora.

alter table public.stock_movements drop constraint stock_movements_movement_type_check;

alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'ENTRADA_NFE', 'SAIDA_NFE', 'VENDA_ML', 'CANCELAMENTO_ML',
  'DEVOLUCAO_ML', 'AJUSTE_MANUAL', 'AJUSTE_RECONCILIACAO', 'TRANSFERENCIA',
  'RESERVA', 'LIBERACAO_RESERVA', 'ENTRADA_TRANSITO', 'RECEBIMENTO_TRANSITO',
  'ESTORNO_PRE_CAPTURA', 'ESTORNO_REVERSAO_EXCEDENTE', 'SAIDA_DOCUMENTO', 'ESTORNO_FULL',
  -- D-495: a venda da Shopee.
  'VENDA_SHOPEE', 'CANCELAMENTO_SHOPEE', 'ESTORNO_ARMAZEM_SHOPEE'
));

-- O extrato com a loja e o dia do pedido da Shopee. O retorno muda: drop e
-- create na mesma transação (as colunas novas vão no fim).
drop function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date);

create function public.get_stock_movements(
  p_organization_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_search text default null,
  p_movement_type text default null,
  p_location_kind text default null,
  p_source_type text default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  id uuid,
  occurred_at timestamptz,
  movement_type text,
  location_kind text,
  qty_delta numeric,
  sku_id uuid,
  sku text,
  sku_title text,
  source_type text,
  source_id text,
  reason text,
  created_by_name text,
  total_count bigint,
  shopee_shop_id uuid,
  shopee_order_day date
)
language sql
stable
security invoker
set search_path = ''
as $$
  select page.id, page.occurred_at, page.movement_type, page.location_kind,
         page.qty_delta, page.sku_id, s.sku, s.title as sku_title,
         page.source_type, page.source_id, page.reason,
         p.full_name as created_by_name,
         (
           select count(*)
           from public.stock_movements m2
           where m2.organization_id = p_organization_id
             and (p_movement_type is null or m2.movement_type = p_movement_type)
             and (p_location_kind is null or m2.location_kind = p_location_kind)
             and (p_source_type is null or m2.source_type = p_source_type)
             and (p_date_from is null or m2.occurred_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo'))
             and (p_date_to is null or m2.occurred_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo'))
             and (
               p_search is null
               or m2.source_id = p_search
               or m2.sku_id in (
                 select k.id from public.skus k
                 where k.organization_id = p_organization_id
                   and (k.sku ilike '%' || p_search || '%' or k.title ilike '%' || p_search || '%')
               )
             )
         )::bigint as total_count,
         -- D-495: a loja e o dia do pedido da Shopee (Sao Paulo), para o link
         -- "Pedido Shopee" abrir a busca no dia certo. NULOS sem o pedido.
         sp.shopee_shop_id,
         sp.dia as shopee_order_day
  from (
    select m.id, m.occurred_at, m.movement_type, m.location_kind, m.qty_delta,
           m.sku_id, m.source_type, m.source_id, m.reason, m.created_by
    from public.stock_movements m
    where m.organization_id = p_organization_id
      and (p_movement_type is null or m.movement_type = p_movement_type)
      and (p_location_kind is null or m.location_kind = p_location_kind)
      and (p_source_type is null or m.source_type = p_source_type)
      and (p_date_from is null or m.occurred_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo'))
      and (p_date_to is null or m.occurred_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo'))
      and (
        p_search is null
        or m.source_id = p_search
        or m.sku_id in (
          select k.id from public.skus k
          where k.organization_id = p_organization_id
            and (k.sku ilike '%' || p_search || '%' or k.title ilike '%' || p_search || '%')
        )
      )
    order by m.occurred_at desc, m.id desc
    limit greatest(least(p_limit, 200), 1)
    offset greatest(p_offset, 0)
  ) page
  join public.skus s on s.id = page.sku_id
  left join public.profiles p on p.id = page.created_by
  left join lateral (
    select o.shopee_shop_id, (o.shopee_created_at at time zone 'America/Sao_Paulo')::date as dia
    from public.shopee_orders o
    where page.source_type = 'SHOPEE_ORDER'
      and o.organization_id = p_organization_id
      and o.order_sn = page.source_id
    order by o.shopee_shop_id
    limit 1
  ) sp on true
  order by page.occurred_at desc, page.id desc
$$;

comment on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) is
  'Extrato paginado do ledger para /estoque/movimentacoes. Busca por SKU/titulo ou referencia externa exata; periodo usa dias civis inclusivos de America/Sao_Paulo. Desde D-495, a loja (shopee_shop_id) e o dia do pedido em Sao Paulo (shopee_order_day) quando a origem e SHOPEE_ORDER, NULOS sem o pedido. Security invoker e RLS preservadas.';

revoke all on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) from public, anon;
grant execute on function public.get_stock_movements(uuid, integer, integer, text, text, text, text, date, date) to authenticated, service_role;
