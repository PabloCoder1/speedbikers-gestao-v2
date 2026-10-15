-- ============================================================
-- D-447 -- devolucoes da Shopee (etapa E7a da frente multicanal; contrato
-- C-62). A primeira fonte financeira que faltava (R9): a API `returns`,
-- conferida na referencia oficial em 14/10/2026 (`v2.returns.get_return_list`
-- e o guia "Return Refund Management").
--
-- - `shopee_returns`: uma linha por devolucao (`return_sn`; um pedido pode ter
--   varias), com a situacao, o motivo, a solucao (devolucao e reembolso ou so
--   reembolso), o valor do reembolso, os prazos e os estados de negociacao,
--   prova e compensacao -- como a Shopee manda, sem interpretar. A
--   documentacao NAO diz em qual situacao o reembolso foi pago: nada aqui
--   chama valor de "reembolsado".
-- - `shopee_return_items`: os itens, com o SKU resolvido como o do pedido
--   (vinculo manual, SKU do anuncio, SKU da propria devolucao).
-- - NAO se guarda: o comprador (nome, e-mail, foto), as fotos da devolucao, o
--   texto livre do comprador e os motivos de disputa.
-- - O worker le por janela de `update_time` a partir do marco da loja
--   (`returns_synced_until`); a gravacao nao regride (leitura mais velha que a
--   guardada e ignorada), como a dos pedidos (D-432).
-- - Leitura: `get_shopee_returns` (a lista) e `get_shopee_returns_summary`
--   (TOTAL so de loja live ja lida, e por loja; nunca lida = NULO).
-- ============================================================

alter table public.shopee_shops add column if not exists returns_synced_until timestamptz;

comment on column public.shopee_shops.returns_synced_until is
  'Ate onde (update_time da Shopee) as devolucoes da loja ja foram lidas (D-447). NULO = nunca; a primeira leitura comeca 90 dias atras.';

create table public.shopee_returns (
  shopee_shop_id uuid not null,
  return_sn text not null check (length(return_sn) between 1 and 64),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- O pedido da devolucao; sem FK: a devolucao pode chegar antes do pedido.
  order_sn text not null check (length(order_sn) between 1 and 64),
  -- REQUESTED, ACCEPTED, CANCELLED, JUDGING, CLOSED, PROCESSING, SELLER_DISPUTE...
  -- como veio: a lista da Shopee cresce.
  status text not null,
  reason text,
  -- O motivo reavaliado pela Shopee ('NONE' quando nao houve).
  reassessed_reason text,
  -- RETURN_REFUND (0 na API) ou REFUND (1, so reembolso).
  return_solution text check (return_solution in ('RETURN_REFUND', 'REFUND')),
  refund_amount numeric,
  amount_before_discount numeric,
  currency text,
  needs_logistics boolean,
  tracking_number text,
  negotiation_status text,
  seller_proof_status text,
  seller_compensation_status text,
  -- RRBOC (antes de o pedido completar) ou RRAOC (depois).
  return_refund_type text,
  -- 0 normal, 1 em transito, 2 recusada na entrega.
  return_refund_request_type smallint,
  validation_type text,
  is_partial_quantity_return boolean,
  is_refund_amount_adjusted boolean,
  due_date timestamptz,
  return_ship_due_date timestamptz,
  return_seller_due_date timestamptz,
  shopee_created_at timestamptz not null,
  shopee_updated_at timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (shopee_shop_id, return_sn),
  constraint shopee_returns_loja_da_organizacao
    foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade
);

create index shopee_returns_org_created_idx on public.shopee_returns (organization_id, shopee_created_at desc);
create index shopee_returns_order_idx on public.shopee_returns (shopee_shop_id, order_sn);

comment on table public.shopee_returns is
  'Devolucoes da Shopee (D-447), uma por return_sn, como a API manda. Sem o comprador, as fotos e o texto livre. A situacao nao e interpretada: a documentacao nao diz em qual o reembolso foi pago.';

create table public.shopee_return_items (
  shopee_shop_id uuid not null,
  return_sn text not null,
  position smallint not null check (position >= 0),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  item_id bigint not null,
  model_id bigint,
  item_name text,
  item_sku text,
  variation_sku text,
  quantity integer not null check (quantity >= 0),
  item_price numeric,
  sku_id uuid references public.skus (id) on delete set null,
  -- MANUAL | SKU_DO_ANUNCIO | SKU_DA_DEVOLUCAO
  vinculo_via text,
  primary key (shopee_shop_id, return_sn, position),
  foreign key (shopee_shop_id, return_sn) references public.shopee_returns (shopee_shop_id, return_sn) on delete cascade,
  constraint shopee_return_items_loja_da_organizacao
    foreign key (shopee_shop_id, organization_id) references public.shopee_shops (id, organization_id) on delete cascade
);

create index shopee_return_items_sku_idx on public.shopee_return_items (sku_id) where sku_id is not null;

comment on table public.shopee_return_items is
  'Itens das devolucoes da Shopee (D-447), substituidos a cada leitura; o SKU resolvido como o do pedido (manual, SKU do anuncio, SKU da devolucao).';

alter table public.shopee_returns enable row level security;
alter table public.shopee_return_items enable row level security;

-- A permissao por loja (D-433): so quem alcanca a loja le.
create policy shopee_returns_select_permitted
  on public.shopee_returns for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

create policy shopee_return_items_select_permitted
  on public.shopee_return_items for select to authenticated
  using (shopee_shop_id in (select private.accessible_shopee_shops()));

revoke all on public.shopee_returns from anon, authenticated;
revoke all on public.shopee_return_items from anon, authenticated;
grant select on public.shopee_returns to authenticated;
grant select on public.shopee_return_items to authenticated;
grant all on public.shopee_returns to service_role;
grant all on public.shopee_return_items to service_role;

-- ------------------------------------------------------------
-- A gravacao de um lote, numa transacao: a devolucao, os itens substituidos
-- e o SKU de cada item. Nao regride. Devolve quantas devolucoes gravou.
-- ------------------------------------------------------------
create or replace function public.shopee_upsert_returns(
  p_shopee_shop_id uuid,
  p_devolucoes jsonb,
  p_synced_at timestamptz default now()
) returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_org uuid;
  v_gravadas text[];
begin
  select organization_id into v_org from public.shopee_shops where id = p_shopee_shop_id;

  if v_org is null then
    raise exception 'loja shopee % nao encontrada', p_shopee_shop_id;
  end if;

  if p_devolucoes is null or jsonb_typeof(p_devolucoes) <> 'array' then
    raise exception 'p_devolucoes precisa ser um array';
  end if;

  with entrada as (
    -- A mesma devolucao duas vezes no lote: vale a leitura mais nova.
    select distinct on (e.return_sn) e.*
    from jsonb_to_recordset(p_devolucoes) as e (
      return_sn text,
      order_sn text,
      status text,
      reason text,
      reassessed_reason text,
      return_solution text,
      refund_amount numeric,
      amount_before_discount numeric,
      currency text,
      needs_logistics boolean,
      tracking_number text,
      negotiation_status text,
      seller_proof_status text,
      seller_compensation_status text,
      return_refund_type text,
      return_refund_request_type smallint,
      validation_type text,
      is_partial_quantity_return boolean,
      is_refund_amount_adjusted boolean,
      due_date timestamptz,
      return_ship_due_date timestamptz,
      return_seller_due_date timestamptz,
      shopee_created_at timestamptz,
      shopee_updated_at timestamptz
    )
    order by e.return_sn, e.shopee_updated_at desc
  ),
  gravadas as (
    insert into public.shopee_returns as r (
      shopee_shop_id, return_sn, organization_id, order_sn, status, reason, reassessed_reason, return_solution,
      refund_amount, amount_before_discount, currency, needs_logistics, tracking_number, negotiation_status,
      seller_proof_status, seller_compensation_status, return_refund_type, return_refund_request_type,
      validation_type, is_partial_quantity_return, is_refund_amount_adjusted, due_date, return_ship_due_date,
      return_seller_due_date, shopee_created_at, shopee_updated_at, synced_at
    )
    select
      p_shopee_shop_id, e.return_sn, v_org, e.order_sn, e.status, e.reason, e.reassessed_reason, e.return_solution,
      e.refund_amount, e.amount_before_discount, e.currency, e.needs_logistics, e.tracking_number, e.negotiation_status,
      e.seller_proof_status, e.seller_compensation_status, e.return_refund_type, e.return_refund_request_type,
      e.validation_type, e.is_partial_quantity_return, e.is_refund_amount_adjusted, e.due_date, e.return_ship_due_date,
      e.return_seller_due_date, e.shopee_created_at, e.shopee_updated_at, p_synced_at
    from entrada e
    on conflict (shopee_shop_id, return_sn) do update set
      order_sn = excluded.order_sn,
      status = excluded.status,
      reason = excluded.reason,
      reassessed_reason = excluded.reassessed_reason,
      return_solution = excluded.return_solution,
      refund_amount = excluded.refund_amount,
      amount_before_discount = excluded.amount_before_discount,
      currency = excluded.currency,
      needs_logistics = excluded.needs_logistics,
      tracking_number = excluded.tracking_number,
      negotiation_status = excluded.negotiation_status,
      seller_proof_status = excluded.seller_proof_status,
      seller_compensation_status = excluded.seller_compensation_status,
      return_refund_type = excluded.return_refund_type,
      return_refund_request_type = excluded.return_refund_request_type,
      validation_type = excluded.validation_type,
      is_partial_quantity_return = excluded.is_partial_quantity_return,
      is_refund_amount_adjusted = excluded.is_refund_amount_adjusted,
      due_date = excluded.due_date,
      return_ship_due_date = excluded.return_ship_due_date,
      return_seller_due_date = excluded.return_seller_due_date,
      shopee_created_at = excluded.shopee_created_at,
      shopee_updated_at = excluded.shopee_updated_at,
      synced_at = excluded.synced_at
    -- NAO REGRIDE: a leitura mais velha que a guardada nao sobrescreve.
    where r.shopee_updated_at <= excluded.shopee_updated_at
    returning r.return_sn
  )
  select coalesce(array_agg(g.return_sn), '{}') into v_gravadas from gravadas g;

  if cardinality(v_gravadas) = 0 then
    return 0;
  end if;

  delete from public.shopee_return_items
   where shopee_shop_id = p_shopee_shop_id
     and return_sn = any (v_gravadas);

  insert into public.shopee_return_items (
    shopee_shop_id, return_sn, position, organization_id, item_id, model_id, item_name, item_sku,
    variation_sku, quantity, item_price
  )
  select
    p_shopee_shop_id, d.devolucao ->> 'return_sn', i.position, v_org, i.item_id, i.model_id, i.item_name, i.item_sku,
    i.variation_sku, i.quantity, i.item_price
  from (
    select distinct on (el ->> 'return_sn') el as devolucao
    from jsonb_array_elements(p_devolucoes) el
    order by el ->> 'return_sn', (el ->> 'shopee_updated_at')::timestamptz desc
  ) d
  cross join lateral jsonb_to_recordset(coalesce(d.devolucao -> 'itens', '[]'::jsonb)) as i (
    position smallint,
    item_id bigint,
    model_id bigint,
    item_name text,
    item_sku text,
    variation_sku text,
    quantity integer,
    item_price numeric
  )
  where d.devolucao ->> 'return_sn' = any (v_gravadas);

  -- O SKU de cada item, como o do pedido (D-430): o vinculo manual, o SKU do
  -- anuncio e, por ultimo, o SKU que a propria devolucao traz.
  with resolvido as (
    select
      i.return_sn,
      i.position,
      coalesce(l.sku_id, u.sku_id, proprio.id) as sku_id,
      case
        when l.id is not null then 'MANUAL'
        when u.sku_id is not null then 'SKU_DO_ANUNCIO'
        when proprio.id is not null then 'SKU_DA_DEVOLUCAO'
      end as vinculo_via
    from public.shopee_return_items i
    left join public.shopee_sku_links l
      on l.shopee_shop_id = i.shopee_shop_id and l.item_id = i.item_id and l.model_id is not distinct from i.model_id
    left join public.shopee_listing_units u
      on u.shopee_shop_id = i.shopee_shop_id and u.item_id = i.item_id and u.model_id is not distinct from i.model_id
     and u.vinculo_via = 'SKU_DO_ANUNCIO'
    left join public.skus proprio
      on proprio.organization_id = i.organization_id
     and proprio.sku_key = upper(btrim(
           case when i.model_id is not null then nullif(btrim(i.variation_sku), '') else nullif(btrim(i.item_sku), '') end
         ))
    where i.shopee_shop_id = p_shopee_shop_id
      and i.return_sn = any (v_gravadas)
  )
  update public.shopee_return_items i
     set sku_id = r.sku_id, vinculo_via = r.vinculo_via
    from resolvido r
   where i.shopee_shop_id = p_shopee_shop_id and i.return_sn = r.return_sn and i.position = r.position;

  return cardinality(v_gravadas);
end;
$$;

comment on function public.shopee_upsert_returns(uuid, jsonb, timestamptz) is
  'Grava um lote de devolucoes Shopee de uma loja numa transacao (D-447): a devolucao (sem regredir), os itens substituidos e o SKU de cada item. Devolve quantas gravou. So o worker (service_role).';

revoke all on function public.shopee_upsert_returns(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.shopee_upsert_returns(uuid, jsonb, timestamptz) to service_role;

create or replace function public.shopee_advance_returns_synced_until(p_shopee_shop_id uuid, p_until timestamptz)
returns timestamptz
language sql
volatile
set search_path = ''
as $$
  update public.shopee_shops
     set returns_synced_until = greatest(returns_synced_until, p_until)
   where id = p_shopee_shop_id
  returning returns_synced_until;
$$;

comment on function public.shopee_advance_returns_synced_until(uuid, timestamptz) is
  'Avanca o marco da leitura de devolucoes de uma loja Shopee sem nunca recuar (D-447); devolve o marco que ficou. So o worker (service_role).';

revoke all on function public.shopee_advance_returns_synced_until(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.shopee_advance_returns_synced_until(uuid, timestamptz) to service_role;

-- ------------------------------------------------------------
-- A lista: devolucoes criadas no periodo (dia de Sao Paulo), com os itens.
-- ------------------------------------------------------------
create or replace function public.get_shopee_returns(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null,
  p_status text[] default null,
  p_order_sn text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  environment text,
  return_sn text,
  order_sn text,
  status text,
  reason text,
  reassessed_reason text,
  return_solution text,
  refund_amount numeric,
  amount_before_discount numeric,
  currency text,
  needs_logistics boolean,
  negotiation_status text,
  seller_proof_status text,
  seller_compensation_status text,
  return_refund_type text,
  due_date timestamptz,
  return_seller_due_date timestamptz,
  shopee_created_at timestamptz,
  shopee_updated_at timestamptz,
  itens jsonb,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  select
    r.shopee_shop_id,
    coalesce(sh.shop_name, 'Loja Shopee ' || sh.shop_id::text),
    sh.environment,
    r.return_sn,
    r.order_sn,
    r.status,
    r.reason,
    r.reassessed_reason,
    r.return_solution,
    r.refund_amount,
    r.amount_before_discount,
    r.currency,
    r.needs_logistics,
    r.negotiation_status,
    r.seller_proof_status,
    r.seller_compensation_status,
    r.return_refund_type,
    r.due_date,
    r.return_seller_due_date,
    r.shopee_created_at,
    r.shopee_updated_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', i.item_id, 'model_id', i.model_id, 'nome', i.item_name, 'quantidade', i.quantity,
               'preco', i.item_price, 'sku_id', i.sku_id, 'sku', s.sku, 'vinculo_via', i.vinculo_via
             ) order by i.position)
      from public.shopee_return_items i
      left join public.skus s on s.id = i.sku_id
      where i.shopee_shop_id = r.shopee_shop_id and i.return_sn = r.return_sn
    ), '[]'::jsonb),
    count(*) over ()
  from public.shopee_returns r
  join public.shopee_shops sh on sh.id = r.shopee_shop_id
  where r.organization_id = p_organization_id
    and (p_account_ids is null or r.shopee_shop_id = any (p_account_ids))
    and (p_status is null or r.status = any (p_status))
    and (p_order_sn is null or r.order_sn = p_order_sn)
    and r.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
    and r.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  order by r.shopee_created_at desc, r.return_sn
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.get_shopee_returns(uuid, date, date, uuid[], text[], text, integer, integer) is
  'D-447 (C-62): devolucoes Shopee criadas no periodo (dia de Sao Paulo), com os itens e o SKU; filtros de loja, situacao e pedido; paginada (ate 200) com total_count. A situacao vem como a Shopee manda. security invoker.';

revoke all on function public.get_shopee_returns(uuid, date, date, uuid[], text[], text, integer, integer) from public, anon;
grant execute on function public.get_shopee_returns(uuid, date, date, uuid[], text[], text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- O resumo: TOTAL (loja live ja lida) e por loja, contado por situacao.
-- ------------------------------------------------------------
create or replace function public.get_shopee_returns_summary(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  nivel text,
  account_id uuid,
  account_name text,
  environment text,
  devolucoes bigint,
  pedidos_com_devolucao bigint,
  so_reembolso bigint,
  unidades bigint,
  valor_reembolso numeric,
  -- { "SITUACAO": { "devolucoes": n, "valor_reembolso": x, "unidades": u } }
  por_situacao jsonb,
  ultima_atualizacao timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment,
           s.returns_synced_until
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  devolucoes as materialized (
    select r.shopee_shop_id, r.return_sn, r.order_sn, r.status, r.return_solution, r.refund_amount,
           (select sum(i.quantity) from public.shopee_return_items i
             where i.shopee_shop_id = r.shopee_shop_id and i.return_sn = r.return_sn) as unidades
    from public.shopee_returns r
    where r.organization_id = p_organization_id
      and r.shopee_shop_id in (select l.id from lojas l)
      and r.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and r.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  por_situacao as (
    select d.shopee_shop_id, d.status, count(*) as n, sum(d.refund_amount) as valor, sum(d.unidades) as unidades
    from devolucoes d
    group by d.shopee_shop_id, d.status
  ),
  por_loja as (
    select
      l.id, l.nome, l.environment, l.returns_synced_until as atualizado,
      l.returns_synced_until is not null as lida,
      (select count(*) from devolucoes d where d.shopee_shop_id = l.id) as devolucoes,
      (select count(distinct d.order_sn) from devolucoes d where d.shopee_shop_id = l.id) as pedidos,
      (select count(*) from devolucoes d where d.shopee_shop_id = l.id and d.return_solution = 'REFUND') as so_reembolso,
      (select sum(d.unidades) from devolucoes d where d.shopee_shop_id = l.id) as unidades,
      (select sum(d.refund_amount) from devolucoes d where d.shopee_shop_id = l.id) as valor
    from lojas l
  ),
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    sum(s.devolucoes)::bigint,
    sum(s.pedidos)::bigint,
    sum(s.so_reembolso)::bigint,
    coalesce(sum(s.unidades), 0)::bigint,
    -- Loja lida sem devolucao: 0; devolucao sem o valor informado: NULO.
    round(coalesce(sum(s.valor), case when sum(s.devolucoes) = 0 then 0 end), 2),
    coalesce((
      select jsonb_object_agg(x.status, jsonb_build_object('devolucoes', x.n, 'valor_reembolso', round(x.valor, 2), 'unidades', coalesce(x.unidades, 0)))
      from (
        select ps.status, sum(ps.n) as n, sum(ps.valor) as valor, sum(ps.unidades) as unidades
        from por_situacao ps
        where ps.shopee_shop_id in (select so.id from somaveis so)
        group by ps.status
      ) x
    ), '{}'::jsonb),
    case when bool_or(s.atualizado is null) then null else min(s.atualizado) end
  from somaveis s
  having count(*) > 0

  union all

  -- Por loja. Loja cujas devolucoes nunca foram lidas: tudo NULO.
  select
    'CONTA', pl.id, pl.nome, pl.environment,
    case when pl.lida then pl.devolucoes end::bigint,
    case when pl.lida then pl.pedidos end::bigint,
    case when pl.lida then pl.so_reembolso end::bigint,
    case when pl.lida then coalesce(pl.unidades, 0) end::bigint,
    case when pl.lida then round(coalesce(pl.valor, case when pl.devolucoes = 0 then 0 end), 2) end,
    case when pl.lida then coalesce((
      select jsonb_object_agg(ps.status, jsonb_build_object('devolucoes', ps.n, 'valor_reembolso', round(ps.valor, 2), 'unidades', coalesce(ps.unidades, 0)))
      from por_situacao ps where ps.shopee_shop_id = pl.id
    ), '{}'::jsonb) end,
    pl.atualizado
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_returns_summary(uuid, date, date, uuid[]) is
  'D-447 (C-62): devolucoes Shopee criadas no periodo, TOTAL (so loja live ja lida) e por loja: quantas, de quantos pedidos, quantas so de reembolso, unidades, o valor de reembolso que a Shopee informa e o mesmo por situacao (como a Shopee manda; a documentacao nao diz em qual o reembolso foi pago). Loja nunca lida: NULO. security invoker.';

revoke all on function public.get_shopee_returns_summary(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_returns_summary(uuid, date, date, uuid[]) to authenticated;
