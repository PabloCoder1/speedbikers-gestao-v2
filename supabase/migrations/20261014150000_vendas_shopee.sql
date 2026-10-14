-- ============================================================
-- D-430 -- as VENDAS da Shopee (fatia 6a da trilha, D-425): a definicao da
-- venda valida, o SKU gravado em cada item de pedido e as leituras por loja.
--
-- Por que RPCs proprias, e nao a Shopee dentro de daily_*_metrics: as tres
-- tabelas diarias sao presas ao Mercado Livre (ml_account_id NOT NULL, RLS e
-- trava por conta, receita por linha de item que so vale com UM item por
-- pedido), e cerca de 30 funcoes as leem -- inclusive a sugestao de compra e a
-- cobertura, que passariam a contar venda Shopee antes da decisao de estoque
-- (fatia 5, adiada para o Go Live pelo dono em 14/10).
--
-- A VENDA SHOPEE (docs/METRICS.md, secao 5S):
-- - valida: pedido PAGO (paid_at preenchido) e fora de UNPAID, CANCELLED e
--   IN_CANCEL (o pending_cancel do ML);
-- - dia: a criacao do pedido no fuso de Sao Paulo, como no ML;
-- - receita bruta: o valor dos PRODUTOS com o desconto da loja, sem o frete e
--   antes dos cupons, moedas e descontos bancados pela Shopee -- o que o ML
--   chama de receita bruta. Do financeiro quando lido
--   (order_income.order_discounted_price); antes, a soma preco x quantidade
--   dos itens; item com preco 0 (bundle deal) torna a receita do pedido
--   DESCONHECIDA (NULO), nunca zero;
-- - recebido: escrow_amount, o numero da propria Shopee, provisorio ate o
--   pedido completar.
-- Loja de SANDBOX nunca entra em total da empresa: as leituras devolvem o
-- ambiente, e a tela marca "Teste".
--
-- O SKU GRAVADO (D-020, como o ML): a cada gravacao do pedido o worker chama
-- shopee_resolve_order_item_skus. Ordem: vinculo manual, SKU do anuncio
-- (a mesma view da tela), e o SKU que veio no proprio pedido -- este ultimo
-- guarda a venda do anuncio que depois foi apagado ou ainda nao foi lido.
-- "Congelado" = como estava na ultima leitura do pedido; pedido completo nao
-- e mais relido. O vinculo manual NOVO preenche so o SKU que faltava nas
-- vendas daquela unidade; nunca troca um SKU ja resolvido.
-- ============================================================

alter table public.shopee_order_items
  add column if not exists sku_id uuid references public.skus (id) on delete set null,
  add column if not exists vinculo_via text check (vinculo_via is null or vinculo_via in ('MANUAL', 'SKU_DO_ANUNCIO', 'SKU_DO_PEDIDO')),
  -- SEM FK: o vinculo manual e apagado fisicamente; o id fica como rastro.
  add column if not exists shopee_sku_link_id uuid;

alter table public.shopee_order_items
  add constraint shopee_order_items_vinculo_coerente check ((sku_id is null) = (vinculo_via is null));

create index if not exists shopee_order_items_sku_idx
  on public.shopee_order_items (organization_id, sku_id) where sku_id is not null;

comment on column public.shopee_order_items.sku_id is
  'SKU da V3 resolvido na gravacao do pedido (D-430): manual, SKU do anuncio ou SKU do proprio pedido. NULO = sem SKU.';

-- ------------------------------------------------------------
-- A resolucao, em SQL, por loja (e pedidos, opcional). So o worker chama.
-- ------------------------------------------------------------
create or replace function public.shopee_resolve_order_item_skus(p_shopee_shop_id uuid, p_order_sns text[] default null)
returns integer
language sql
volatile
set search_path = ''
as $$
  with resolvido as (
    select
      i.shopee_shop_id,
      i.order_sn,
      i.position,
      coalesce(l.sku_id, u.sku_id, proprio.id) as sku_id,
      case
        when l.id is not null then 'MANUAL'
        when u.sku_id is not null then 'SKU_DO_ANUNCIO'
        when proprio.id is not null then 'SKU_DO_PEDIDO'
      end as vinculo_via,
      l.id as link_id
    from public.shopee_order_items i
    left join public.shopee_sku_links l
      on l.shopee_shop_id = i.shopee_shop_id and l.item_id = i.item_id and l.model_id is not distinct from i.model_id
    left join public.shopee_listing_units u
      on u.shopee_shop_id = i.shopee_shop_id and u.item_id = i.item_id and u.model_id is not distinct from i.model_id
     and u.vinculo_via = 'SKU_DO_ANUNCIO'
    left join public.skus proprio
      on proprio.organization_id = i.organization_id
     and proprio.sku_key = upper(btrim(
           case when i.model_id is not null then nullif(btrim(i.model_sku), '') else nullif(btrim(i.item_sku), '') end
         ))
    where i.shopee_shop_id = p_shopee_shop_id
      and (p_order_sns is null or i.order_sn = any (p_order_sns))
  ),
  gravado as (
    update public.shopee_order_items i
       set sku_id = r.sku_id, vinculo_via = r.vinculo_via, shopee_sku_link_id = r.link_id
      from resolvido r
     where i.shopee_shop_id = r.shopee_shop_id and i.order_sn = r.order_sn and i.position = r.position
       and (i.sku_id, i.vinculo_via, i.shopee_sku_link_id) is distinct from (r.sku_id, r.vinculo_via, r.link_id)
    returning 1
  )
  select count(*)::integer from gravado;
$$;

comment on function public.shopee_resolve_order_item_skus(uuid, text[]) is
  'Grava o SKU dos itens de pedido Shopee de uma loja (D-430): manual, SKU do anuncio (shopee_listing_units), SKU do proprio pedido. Devolve quantas linhas mudaram. So o worker (service_role).';

revoke all on function public.shopee_resolve_order_item_skus(uuid, text[]) from public, anon, authenticated;
grant execute on function public.shopee_resolve_order_item_skus(uuid, text[]) to service_role;

-- ------------------------------------------------------------
-- O vinculo manual novo preenche o SKU que FALTAVA nas vendas da unidade.
-- ------------------------------------------------------------
create or replace function private.shopee_fill_order_item_skus(
  p_shopee_shop_id uuid, p_item_id bigint, p_model_id bigint, p_link_id uuid, p_sku_id uuid
) returns void
language sql
volatile
set search_path = ''
as $$
  update public.shopee_order_items
     set sku_id = p_sku_id, vinculo_via = 'MANUAL', shopee_sku_link_id = p_link_id
   where shopee_shop_id = p_shopee_shop_id
     and item_id = p_item_id
     and model_id is not distinct from p_model_id
     and sku_id is null;
$$;

revoke all on function private.shopee_fill_order_item_skus(uuid, bigint, bigint, uuid, uuid) from public, anon, authenticated;

create or replace function public.set_shopee_sku_link(
  p_shopee_shop_id uuid,
  p_item_id bigint,
  p_model_id bigint,
  p_sku_id uuid,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_ator uuid := (select auth.uid());
  v_sku_org uuid;
  v_atual public.shopee_sku_links;
  v_id uuid;
  v_motivo text := nullif(btrim(p_reason), '');
begin
  select organization_id into v_org from public.shopee_shops where id = p_shopee_shop_id;

  if v_org is null then
    raise exception 'loja shopee % nao encontrada', p_shopee_shop_id;
  end if;

  if v_ator is null or not private.has_org_role(v_org, array['ADMIN', 'GESTOR', 'OPERADOR']) then
    raise exception 'sem permissao para vincular anuncios desta loja';
  end if;

  select organization_id into v_sku_org from public.skus where id = p_sku_id;

  if v_sku_org is null or v_sku_org <> v_org then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  -- D-316: a unidade tem de estar no catalogo sincronizado, e viva.
  if p_model_id is not null then
    if not exists (
      select 1
      from public.shopee_item_models m
      join public.shopee_items i on i.shopee_shop_id = m.shopee_shop_id and i.item_id = m.item_id
      where m.shopee_shop_id = p_shopee_shop_id and m.item_id = p_item_id and m.model_id = p_model_id
        and i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')
    ) then
      raise exception 'variacao nao encontrada no catalogo sincronizado';
    end if;
  else
    if not exists (
      select 1 from public.shopee_items i
      where i.shopee_shop_id = p_shopee_shop_id and i.item_id = p_item_id
        and i.item_status not in ('SELLER_DELETE', 'SHOPEE_DELETE')
        and i.details_synced_at is not null
        and i.has_model is false
    ) then
      raise exception 'item sem variacao nao encontrado no catalogo sincronizado';
    end if;

    -- D-119: item com variacao recebe vinculo por variacao, nunca no item inteiro.
    if exists (
      select 1 from public.shopee_item_models m
      where m.shopee_shop_id = p_shopee_shop_id and m.item_id = p_item_id
    ) then
      raise exception 'item com variacao: vincule cada variacao';
    end if;
  end if;

  select * into v_atual
  from public.shopee_sku_links l
  where l.shopee_shop_id = p_shopee_shop_id and l.item_id = p_item_id
    and l.model_id is not distinct from p_model_id
  for update;

  if found then
    if v_atual.sku_id = p_sku_id then
      perform private.shopee_fill_order_item_skus(p_shopee_shop_id, p_item_id, p_model_id, v_atual.id, p_sku_id);
      return v_atual.id;
    end if;

    update public.shopee_sku_links
       set sku_id = p_sku_id, updated_by = v_ator, updated_at = now()
     where id = v_atual.id;

    insert into public.shopee_sku_link_events
      (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, previous_sku_id, actor_user_id, reason)
    values
      (v_org, p_shopee_shop_id, v_atual.id, 'RETARGETED', p_item_id, p_model_id, p_sku_id, v_atual.sku_id, v_ator, v_motivo);

    perform private.shopee_fill_order_item_skus(p_shopee_shop_id, p_item_id, p_model_id, v_atual.id, p_sku_id);

    return v_atual.id;
  end if;

  insert into public.shopee_sku_links (organization_id, shopee_shop_id, item_id, model_id, sku_id, created_by, updated_by)
  values (v_org, p_shopee_shop_id, p_item_id, p_model_id, p_sku_id, v_ator, v_ator)
  returning id into v_id;

  insert into public.shopee_sku_link_events
    (organization_id, shopee_shop_id, link_id, event_type, item_id, model_id, sku_id, actor_user_id, reason)
  values
    (v_org, p_shopee_shop_id, v_id, 'CREATED', p_item_id, p_model_id, p_sku_id, v_ator, v_motivo);

  perform private.shopee_fill_order_item_skus(p_shopee_shop_id, p_item_id, p_model_id, v_id, p_sku_id);

  return v_id;
end;
$$;


comment on function public.set_shopee_sku_link(uuid, bigint, bigint, uuid, text) is
  'Vinculo manual de uma unidade de anuncio Shopee (D-429): cria ou troca o SKU, com evento, e preenche o SKU que faltava nas vendas da unidade (D-430). Exige ADMIN/GESTOR/OPERADOR na organizacao da loja, SKU da mesma organizacao e a unidade no catalogo sincronizado.';

-- O que ja foi gravado ganha o SKU agora.
select public.shopee_resolve_order_item_skus(id) from public.shopee_shops;

-- ------------------------------------------------------------
-- As leituras. Uma definicao de "pedido de venda" para as duas.
-- ------------------------------------------------------------
create or replace view public.shopee_sales_orders
with (security_invoker = true)
as
select
  o.organization_id,
  o.shopee_shop_id,
  sh.shop_name,
  sh.environment,
  o.order_sn,
  o.order_status,
  o.shopee_created_at,
  (o.shopee_created_at at time zone 'America/Sao_Paulo')::date as dia,
  o.paid_at,
  case
    when o.order_status in ('CANCELLED', 'IN_CANCEL') then 'CANCELADA'
    when o.paid_at is null or o.order_status = 'UNPAID' then 'NAO_PAGA'
    else 'VALIDA'
  end as situacao,
  itens.unidades,
  itens.sem_sku,
  itens.resumo,
  coalesce((o.order_income ->> 'order_discounted_price')::numeric, itens.receita_pelos_itens) as receita_bruta,
  o.escrow_amount as recebido,
  o.financials_synced_at is not null and o.order_income is not null as financeiro_lido,
  coalesce(cardinality(o.return_order_sns), 0) > 0 as com_devolucao
from public.shopee_orders o
join public.shopee_shops sh on sh.id = o.shopee_shop_id
left join lateral (
  select
    sum(i.quantity) as unidades,
    count(*) filter (where i.sku_id is null) as sem_sku,
    case when bool_and(i.discounted_price > 0) then sum(i.discounted_price * i.quantity) end as receita_pelos_itens,
    jsonb_agg(
      jsonb_build_object(
        'item_id', i.item_id, 'model_id', i.model_id, 'nome', i.item_name, 'variacao', i.model_name,
        'quantidade', i.quantity, 'sku_id', i.sku_id, 'sku', s.sku, 'vinculo_via', i.vinculo_via
      ) order by i.position
    ) as resumo
  from public.shopee_order_items i
  left join public.skus s on s.id = i.sku_id
  where i.shopee_shop_id = o.shopee_shop_id and i.order_sn = o.order_sn
) itens on true;

comment on view public.shopee_sales_orders is
  'Pedido Shopee com a situacao da venda (VALIDA, CANCELADA, NAO_PAGA), o dia em Sao Paulo, a receita bruta (financeiro, senao os itens; NULO com item de preco 0) e o recebido (D-430, docs/METRICS.md 5S). Traz o ambiente: sandbox nunca entra em total da empresa.';

revoke all on public.shopee_sales_orders from anon, authenticated;
grant select on public.shopee_sales_orders to authenticated;
grant select on public.shopee_sales_orders to service_role;

create or replace function public.get_shopee_sales_by_shop(p_organization_id uuid, p_date_from date, p_date_to date)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  environment text,
  connection_status text,
  pedidos bigint,
  unidades bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  recebido numeric,
  pedidos_sem_recebido bigint,
  cancelados bigint,
  com_devolucao bigint,
  pedidos_sem_sku bigint,
  ultima_leitura timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    sh.id,
    sh.shop_name,
    sh.environment,
    sh.status,
    count(v.order_sn) filter (where v.situacao = 'VALIDA'),
    coalesce(sum(v.unidades) filter (where v.situacao = 'VALIDA'), 0),
    sum(v.receita_bruta) filter (where v.situacao = 'VALIDA'),
    count(v.order_sn) filter (where v.situacao = 'VALIDA' and v.receita_bruta is null),
    sum(v.recebido) filter (where v.situacao = 'VALIDA' and v.financeiro_lido),
    count(v.order_sn) filter (where v.situacao = 'VALIDA' and not v.financeiro_lido),
    count(v.order_sn) filter (where v.situacao = 'CANCELADA'),
    count(v.order_sn) filter (where v.situacao = 'VALIDA' and v.com_devolucao),
    count(v.order_sn) filter (where v.situacao = 'VALIDA' and v.sem_sku > 0),
    sh.orders_synced_until
  from public.shopee_shops sh
  left join public.shopee_sales_orders v
    on v.shopee_shop_id = sh.id and v.dia between p_date_from and p_date_to
  where sh.organization_id = p_organization_id
  group by sh.id, sh.shop_name, sh.environment, sh.status, sh.orders_synced_until
  order by sh.environment = 'sandbox', sh.shop_name nulls last;
$$;

comment on function public.get_shopee_sales_by_shop(uuid, date, date) is
  'Vendas Shopee por loja no periodo (D-430): pedidos validos, unidades, receita bruta (NULA se nenhum pedido tem receita conhecida; os sem receita contados a parte), recebido (so pedidos com financeiro lido), cancelados, devolucoes, pedidos com item sem SKU e a ultima leitura. Uma linha por loja, inclusive sandbox (ambiente devolvido).';

revoke all on function public.get_shopee_sales_by_shop(uuid, date, date) from public, anon;
grant execute on function public.get_shopee_sales_by_shop(uuid, date, date) to authenticated;

create or replace function public.get_shopee_orders(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_shopee_shop_id uuid default null,
  p_situacao text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  environment text,
  order_sn text,
  order_status text,
  situacao text,
  shopee_created_at timestamptz,
  unidades bigint,
  receita_bruta numeric,
  recebido numeric,
  financeiro_lido boolean,
  com_devolucao boolean,
  itens jsonb,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    v.shopee_shop_id, v.shop_name, v.environment, v.order_sn, v.order_status, v.situacao, v.shopee_created_at,
    v.unidades, v.receita_bruta, v.recebido, v.financeiro_lido, v.com_devolucao, v.resumo,
    count(*) over ()
  from public.shopee_sales_orders v
  where v.organization_id = p_organization_id
    and v.dia between p_date_from and p_date_to
    and (p_shopee_shop_id is null or v.shopee_shop_id = p_shopee_shop_id)
    and (p_situacao is null or v.situacao = p_situacao)
  order by v.shopee_created_at desc, v.order_sn
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer) is
  'Pedidos Shopee no periodo (D-430), mais novos primeiro, com situacao, receita bruta, recebido, financeiro lido, devolucao e os itens com o SKU gravado; filtro por loja e situacao; paginada (ate 200) com total_count.';

revoke all on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer) from public, anon;
grant execute on function public.get_shopee_orders(uuid, date, date, uuid, text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (secao 5S).
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_pedidos', 'Pedidos da Shopee',
   'COUNT(shopee_orders) com situacao VALIDA',
   'shopee_sales_orders (shopee_orders, shopee_shops)', array['account', 'organization'],
   'Pedido pago (paid_at preenchido) fora de UNPAID, CANCELLED e IN_CANCEL; dia civil de shopee_created_at em Sao Paulo.',
   'Cancelado, em cancelamento e nao pago. Loja de sandbox nunca entra em total da empresa.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_unidades', 'Unidades vendidas na Shopee',
   'SUM(shopee_order_items.quantity) dos pedidos validos',
   'shopee_sales_orders', array['sku', 'account', 'organization'],
   'Itens dos pedidos validos (shopee_pedidos).',
   'Itens de pedido cancelado, em cancelamento ou nao pago.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_receita_bruta', 'Receita bruta da Shopee',
   'order_income.order_discounted_price; antes do financeiro, SUM(discounted_price x quantity) dos itens',
   'shopee_sales_orders (shopee_orders.order_income, shopee_order_items)', array['account', 'organization'],
   'Valor dos produtos com o desconto da loja, sem o frete e antes de cupons, moedas e descontos bancados pela Shopee -- o que o ML chama de receita bruta.',
   'Pedido com item de preco 0 (bundle deal) sem financeiro lido: receita DESCONHECIDA (NULO), contada a parte, nunca zero. Devolucao nao reduz.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_recebido', 'Recebido da Shopee',
   'SUM(shopee_orders.escrow_amount) dos pedidos validos com financeiro lido',
   'shopee_orders.escrow_amount (get_escrow_detail, D-427)', array['account', 'organization'],
   'O que a loja recebe pelo pedido, pela propria Shopee: ja desconta comissao, taxas, frete que fica com a loja, cupons da loja e afiliados.',
   'Pedido sem financeiro lido: fora da soma e contado a parte. Provisorio ate o pedido completar.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14');
