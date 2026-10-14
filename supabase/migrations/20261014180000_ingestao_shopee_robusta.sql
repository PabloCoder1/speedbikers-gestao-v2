-- ============================================================
-- D-432 -- a ingestao da Shopee aguenta volume (etapa E1 da frente
-- multicanal, docs/MULTICHANNEL_CONTRACTS.md secao 7).
--
-- Tres defeitos achados na auditoria de 14/10 (R1, R2, R8), nenhum visivel
-- com a loja de teste (um pedido), todos certos com loja real:
--
-- 1. PEDIDO ENVENENADO NO FINANCEIRO. Um erro definitivo da Shopee em UM
--    pedido fazia `shopee.order-financials.sync` falhar antes dos outros, e
--    o pedido nunca lido voltava primeiro em toda execucao: o financeiro da
--    loja inteira parava. E o defeito que D-428 corrigiu no catalogo
--    (`details_error`), sem o espelho aqui. Agora o erro fica no pedido
--    (`financials_error`, `financials_error_at`), a fila segue e ele volta
--    em 1 dia ou quando mudar na Shopee. `financials_synced_at` continua
--    querendo dizer "a ultima leitura que serviu".
--
-- 2. GRAVACAO DO PEDIDO EM QUATRO CHAMADAS. upsert do pedido, apagar itens,
--    inserir itens e resolver o SKU iam em chamadas separadas do PostgREST:
--    falha no meio deixava pedido sem itens, e duas execucoes na mesma loja
--    (a fila roda duas ao mesmo tempo; o encadeamento do historico cruza o
--    gatilho horario) podiam gravar a leitura velha por cima da nova.
--    `shopee_upsert_orders` faz tudo numa transacao e NAO regride: o pedido
--    so e regravado com `update_time` igual ou mais novo que o guardado.
--    O marco da loja so anda para a frente (`shopee_advance_orders_synced_until`).
--
-- 3. ORGANIZACAO SOLTA DA LOJA. `organization_id` dos pedidos, itens e
--    catalogo nao era amarrado ao da loja; so o worker escreve, mas nada
--    impedia um par incoerente. Agora e chave estrangeira composta.
--
-- De carona (C-55, pedido do Agente 2): `get_sku_shopee_listings` devolve o
-- ambiente da loja, para o painel do SKU marcar a loja de teste.
--
-- Compativel com o worker anterior (562b1e60): as tabelas so ganham colunas
-- nulas, e a fila do financeiro se comporta igual enquanto ninguem grava
-- `financials_error`. Publicar: esta migration, depois o worker.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O erro do financeiro, por pedido.
-- ------------------------------------------------------------
alter table public.shopee_orders
  add column if not exists financials_error text,
  add column if not exists financials_error_at timestamptz;

alter table public.shopee_orders
  add constraint shopee_orders_financials_error_coerente
  check ((financials_error is null) = (financials_error_at is null));

comment on column public.shopee_orders.financials_error is
  'Por que a ultima tentativa de ler o financeiro recusou ESTE pedido (codigo da Shopee ou fora do contrato) (D-432). NULO = a ultima tentativa serviu ou nunca houve erro. O pedido volta a fila em 1 dia ou quando mudar.';
comment on column public.shopee_orders.financials_error_at is
  'Quando o financeiro deste pedido foi recusado (D-432). Junto com financials_error.';

-- Mesma assinatura: create or replace basta.
create or replace function public.shopee_orders_financials_pending(p_shopee_shop_id uuid, p_limit integer default 100)
returns table (order_sn text)
language sql
stable
set search_path = ''
as $$
  select o.order_sn
  from public.shopee_orders o
  where o.shopee_shop_id = p_shopee_shop_id
    and o.paid_at is not null
    and (
      (
        o.financials_error is null
        and (
          o.financials_synced_at is null
          or o.shopee_updated_at > o.financials_synced_at
          or (o.order_status not in ('COMPLETED', 'CANCELLED') and o.financials_synced_at < now() - interval '24 hours')
        )
      )
      -- Recusado: so depois de 1 dia, ou se o pedido mudou na Shopee depois
      -- da recusa. E o recuo que impede o pedido ruim de travar a fila.
      or (
        o.financials_error is not null
        and (o.financials_error_at < now() - interval '1 day' or o.shopee_updated_at > o.financials_error_at)
      )
    )
  order by (o.financials_error is not null), o.financials_synced_at nulls first, o.shopee_updated_at
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

comment on function public.shopee_orders_financials_pending(uuid, integer) is
  'Pedidos pagos de uma loja Shopee cujo financeiro precisa ser lido (D-427, D-432): nunca lidos primeiro; recusados so depois de 1 dia ou de mudarem, e por ultimo. So o worker (service_role) chama.';

-- ------------------------------------------------------------
-- 2. A gravacao do lote de pedidos, numa transacao, sem regredir.
--
-- p_pedidos: array de objetos com as colunas de shopee_orders (datas em ISO)
-- e `itens`, array com as colunas de shopee_order_items (`position` incluso).
-- O worker normaliza os campos (vazio vira nulo); aqui so se grava.
-- Devolve quantos pedidos foram gravados; o resto era leitura mais velha que
-- a guardada e foi ignorado, com os itens dele.
-- ------------------------------------------------------------
create or replace function public.shopee_upsert_orders(
  p_shopee_shop_id uuid,
  p_pedidos jsonb,
  p_synced_at timestamptz default now()
) returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_org uuid;
  v_gravados text[];
begin
  select organization_id into v_org from public.shopee_shops where id = p_shopee_shop_id;

  if v_org is null then
    raise exception 'loja shopee % nao encontrada', p_shopee_shop_id;
  end if;

  if p_pedidos is null or jsonb_typeof(p_pedidos) <> 'array' then
    raise exception 'p_pedidos precisa ser um array';
  end if;

  with entrada as (
    -- O mesmo pedido duas vezes no lote: vale a leitura mais nova.
    select distinct on (e.order_sn) e.*
    from jsonb_to_recordset(p_pedidos) as e (
      order_sn text,
      order_status text,
      currency text,
      cod boolean,
      total_amount numeric,
      shopee_created_at timestamptz,
      shopee_updated_at timestamptz,
      paid_at timestamptz,
      shipping_carrier text,
      payment_method text,
      cancel_by text,
      cancel_reason text
    )
    order by e.order_sn, e.shopee_updated_at desc
  ),
  gravados as (
    insert into public.shopee_orders as o (
      shopee_shop_id, organization_id, order_sn, order_status, currency, cod, total_amount,
      shopee_created_at, shopee_updated_at, paid_at, shipping_carrier, payment_method,
      cancel_by, cancel_reason, synced_at
    )
    select
      p_shopee_shop_id, v_org, e.order_sn, e.order_status, e.currency, e.cod, e.total_amount,
      e.shopee_created_at, e.shopee_updated_at, e.paid_at, e.shipping_carrier, e.payment_method,
      e.cancel_by, e.cancel_reason, p_synced_at
    from entrada e
    on conflict (shopee_shop_id, order_sn) do update set
      order_status = excluded.order_status,
      currency = excluded.currency,
      cod = excluded.cod,
      total_amount = excluded.total_amount,
      shopee_created_at = excluded.shopee_created_at,
      shopee_updated_at = excluded.shopee_updated_at,
      paid_at = excluded.paid_at,
      shipping_carrier = excluded.shipping_carrier,
      payment_method = excluded.payment_method,
      cancel_by = excluded.cancel_by,
      cancel_reason = excluded.cancel_reason,
      synced_at = excluded.synced_at
    -- NAO REGRIDE: a leitura mais velha que a guardada nao sobrescreve.
    where o.shopee_updated_at <= excluded.shopee_updated_at
    returning o.order_sn
  )
  select coalesce(array_agg(g.order_sn), '{}') into v_gravados from gravados g;

  if cardinality(v_gravados) = 0 then
    return 0;
  end if;

  delete from public.shopee_order_items
   where shopee_shop_id = p_shopee_shop_id
     and order_sn = any (v_gravados);

  insert into public.shopee_order_items (
    shopee_shop_id, order_sn, position, organization_id, item_id, item_name, item_sku,
    model_id, model_name, model_sku, quantity, original_price, discounted_price, promotion_type
  )
  select
    p_shopee_shop_id, p.pedido ->> 'order_sn', i.position, v_org, i.item_id, i.item_name, i.item_sku,
    i.model_id, i.model_name, i.model_sku, i.quantity, i.original_price, i.discounted_price, i.promotion_type
  from (
    -- Um pedido repetido no lote entra uma vez, com os itens da leitura mais nova.
    select distinct on (el ->> 'order_sn') el as pedido
    from jsonb_array_elements(p_pedidos) el
    order by el ->> 'order_sn', (el ->> 'shopee_updated_at')::timestamptz desc
  ) p
  cross join lateral jsonb_to_recordset(coalesce(p.pedido -> 'itens', '[]'::jsonb)) as i (
    position smallint,
    item_id bigint,
    item_name text,
    item_sku text,
    model_id bigint,
    model_name text,
    model_sku text,
    quantity integer,
    original_price numeric,
    discounted_price numeric,
    promotion_type text
  )
  where p.pedido ->> 'order_sn' = any (v_gravados);

  -- D-430: o SKU de cada item, na mesma transacao.
  perform public.shopee_resolve_order_item_skus(p_shopee_shop_id, v_gravados);

  return cardinality(v_gravados);
end;
$$;

comment on function public.shopee_upsert_orders(uuid, jsonb, timestamptz) is
  'Grava um lote de pedidos Shopee de uma loja numa transacao (D-432): o pedido, os itens substituidos e o SKU resolvido. Nao regride: leitura com update_time mais velho que o guardado e ignorada. A organizacao vem da loja. Devolve quantos gravou. So o worker (service_role).';

revoke all on function public.shopee_upsert_orders(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.shopee_upsert_orders(uuid, jsonb, timestamptz) to service_role;

-- O marco da leitura de pedidos so anda para a frente: uma execucao que
-- termina depois de outra, com uma janela mais curta, nao o puxa para tras.
create or replace function public.shopee_advance_orders_synced_until(p_shopee_shop_id uuid, p_until timestamptz)
returns timestamptz
language sql
volatile
set search_path = ''
as $$
  update public.shopee_shops
     set orders_synced_until = greatest(orders_synced_until, p_until)
   where id = p_shopee_shop_id
  returning orders_synced_until;
$$;

comment on function public.shopee_advance_orders_synced_until(uuid, timestamptz) is
  'Avanca o marco da leitura de pedidos de uma loja Shopee sem nunca recuar (D-432); devolve o marco que ficou. So o worker (service_role).';

revoke all on function public.shopee_advance_orders_synced_until(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.shopee_advance_orders_synced_until(uuid, timestamptz) to service_role;

-- ------------------------------------------------------------
-- 3. A organizacao amarrada a loja.
-- ------------------------------------------------------------
alter table public.shopee_shops
  add constraint shopee_shops_id_organizacao_unica unique (id, organization_id);

alter table public.shopee_orders
  add constraint shopee_orders_loja_da_organizacao
  foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade;

alter table public.shopee_order_items
  add constraint shopee_order_items_loja_da_organizacao
  foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade;

alter table public.shopee_items
  add constraint shopee_items_loja_da_organizacao
  foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade;

alter table public.shopee_item_models
  add constraint shopee_item_models_loja_da_organizacao
  foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade;

-- ------------------------------------------------------------
-- C-55: o ambiente da loja no painel Shopee do SKU. O retorno muda: drop e
-- create na mesma transacao (a coluna nova vai no fim).
-- ------------------------------------------------------------
drop function public.get_sku_shopee_listings(uuid, uuid);

create function public.get_sku_shopee_listings(p_organization_id uuid, p_sku_id uuid)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  item_id bigint,
  model_id bigint,
  item_name text,
  model_name text,
  sku_anuncio text,
  item_status text,
  model_status text,
  currency text,
  current_price numeric,
  available_stock integer,
  vinculo_via text,
  manual_link_id uuid,
  environment text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    u.shopee_shop_id,
    sh.shop_name,
    u.item_id,
    u.model_id,
    u.item_name,
    u.model_name,
    u.sku_anuncio,
    u.item_status,
    u.model_status,
    u.currency,
    u.current_price,
    u.available_stock,
    u.vinculo_via,
    u.manual_link_id,
    sh.environment
  from public.shopee_listing_units u
  join public.shopee_shops sh on sh.id = u.shopee_shop_id
  where u.organization_id = p_organization_id
    and u.sku_id = p_sku_id
  order by sh.shop_name nulls last, u.item_name nulls last, u.item_id, u.model_id nulls first
  limit 200;
$$;

comment on function public.get_sku_shopee_listings(uuid, uuid) is
  'Anuncios Shopee vinculados a um SKU (D-429), pelo vinculo manual ou pelo SKU do anuncio, com o ambiente da loja (D-432; sandbox nunca e venda real); ate 200.';

revoke all on function public.get_sku_shopee_listings(uuid, uuid) from public, anon;
grant execute on function public.get_sku_shopee_listings(uuid, uuid) to authenticated;
