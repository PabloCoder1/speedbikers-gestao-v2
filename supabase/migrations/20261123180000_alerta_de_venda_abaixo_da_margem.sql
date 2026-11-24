-- D-858 — Alerta de venda abaixo da margem: no sino do sistema e por e-mail.
--
-- O dono pediu (23/11): toda venda com margem abaixo da meta avisa, dentro do
-- sistema e por e-mail, para uma lista de endereços que ele escolhe. A meta é
-- 40% para as marcas importadas (Navetec, Off Racer, Off Volt) e 30% para o
-- resto.
--
-- A MARGEM É A DE 5X (`get_sku_margins`), pedido a pedido:
--   (valor líquido recebido − custo do produto) ÷ valor de venda
--   ML: recebido = preço × quantidade − comissão − frete do vendedor (5F).
--   Shopee: recebido = escrow + ajustes depois do repasse (5U).
--   Custo: o da data da venda (histórico; sem histórico, o do cadastro); kit
--   pela soma dos componentes.
-- Só o pedido COBERTO entra, pela mesma regra da tela: no ML, frete e comissão
-- observados, custo conhecido e uma linha de item; na Shopee, financeiro lido,
-- custo de todos os itens e um SKU só. Pedido sem custo, sem frete ou com
-- vários produtos não é julgado: ausência de dado não vira margem (nem zero).
-- O mesmo pedido que ainda não estava coberto é julgado de novo na rodada
-- seguinte, até 7 dias depois da venda.
--
-- 1. `margin_alert_settings` — a configuração por organização: liga/desliga,
--    as duas metas, as marcas importadas e os e-mails. A lista de e-mails é
--    dado do cliente e mora só no banco: o repositório é público.
-- 2. `sale_margin_alerts` — uma linha por venda alertada (o pedido inteiro),
--    com os números do julgamento e o estado do e-mail. A unicidade por
--    pedido é o que faz o alerta cair UMA vez.
-- 3. `detectar_vendas_abaixo_da_margem` — o julgamento, em SQL. Grava o
--    alerta e, na mesma transação, o `domain_event` `sale.margin.below`, que o
--    fan-out de D-073 transforma em notificação (sino e toast) para quem
--    alcança a conta ou a loja. O worker chama a cada hora e manda o e-mail.
--
-- Só vale para vendas DEPOIS de ligar (`active_since`): a primeira rodada não
-- despeja o histórico na caixa de ninguém.

-- ---------------------------------------------------------------------------
-- 0. Auxiliares
-- ---------------------------------------------------------------------------

-- A chave de comparação da marca: maiúsculas, só letras e dígitos. "Off Racer",
-- "OFF RACER" e "OFFRACER" são a mesma marca no cadastro.
create or replace function private.chave_da_marca(p_marca text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(regexp_replace(upper(coalesce(p_marca, '')), '[^A-Z0-9]', '', 'g'), '');
$$;

create or replace function private.emails_validos(p_emails text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(bool_and(e ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(e) <= 254), true)
  from unnest(coalesce(p_emails, '{}'::text[])) as e;
$$;

-- ---------------------------------------------------------------------------
-- 1. Configuração
-- ---------------------------------------------------------------------------

create table public.margin_alert_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  default_min_margin numeric(5, 4) not null default 0.30
    check (default_min_margin > -1 and default_min_margin < 1),
  imported_min_margin numeric(5, 4) not null default 0.40
    check (imported_min_margin > -1 and imported_min_margin < 1),
  imported_brands text[] not null default array['NAVETEC', 'OFF RACER', 'OFF VOLT']
    check (cardinality(imported_brands) <= 50),
  email_recipients text[] not null default '{}'
    check (cardinality(email_recipients) <= 20 and private.emails_validos(email_recipients)),
  -- Vendas antes deste instante nunca alertam. Religar não muda: o que vendeu
  -- desligado não é cobrado depois.
  active_since timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.margin_alert_settings is
  'Alerta de venda abaixo da margem (D-858), por organização: liga/desliga, a meta padrão (default_min_margin), a meta das marcas importadas (imported_min_margin, para os SKUs cuja marca do fornecedor (supplier_brand, comparada por private.chave_da_marca) está em imported_brands, ou kit com componente delas) e os e-mails que recebem o aviso. Só vendas a partir de active_since. ADMIN e GESTOR alteram.';

create trigger margin_alert_settings_set_updated_at
  before update on public.margin_alert_settings
  for each row execute function private.set_updated_at();

alter table public.margin_alert_settings enable row level security;

create policy margin_alert_settings_select_member
  on public.margin_alert_settings for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy margin_alert_settings_insert_admin
  on public.margin_alert_settings for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));

create policy margin_alert_settings_update_admin
  on public.margin_alert_settings for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN', 'GESTOR']));

revoke all on public.margin_alert_settings from anon, authenticated;
grant select, insert, update on public.margin_alert_settings to authenticated;
grant select, insert, update on public.margin_alert_settings to service_role;

-- As organizações que já existem nascem ligadas, com as metas do dono e sem
-- e-mail: o sino já funciona, e o e-mail começa quando alguém cadastrar a lista.
insert into public.margin_alert_settings (organization_id)
select o.id from public.organizations o
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Vendas alertadas
-- ---------------------------------------------------------------------------

create table public.sale_margin_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  marketplace text not null check (marketplace in ('MERCADO_LIVRE', 'SHOPEE')),
  ml_account_id uuid references public.ml_accounts(id) on delete cascade,
  shopee_shop_id uuid references public.shopee_shops(id) on delete cascade,
  -- O pedido do ML (número) ou o order_sn da Shopee.
  order_ref text not null check (char_length(order_ref) between 1 and 64),
  sku_id uuid references public.skus(id) on delete set null,
  sku text,
  title text,
  brand text,
  imported boolean not null,
  quantity integer,
  sold_at timestamptz not null,
  sale_value numeric not null,
  net_received numeric not null,
  product_cost numeric not null,
  margin numeric not null,
  min_margin numeric not null,
  -- O custo veio do cadastro atual, não do histórico da data da venda.
  cost_is_current boolean not null default false,
  detected_at timestamptz not null default now(),
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'failed', 'skipped')),
  email_attempts integer not null default 0,
  email_sent_at timestamptz,
  email_error text,
  check ((marketplace = 'MERCADO_LIVRE') = (ml_account_id is not null)),
  check ((marketplace = 'SHOPEE') = (shopee_shop_id is not null))
);

comment on table public.sale_margin_alerts is
  'Uma linha por venda (pedido) julgada abaixo da margem (D-858): os números do julgamento (valor de venda, recebido, custo, margem e a meta que valia) e o estado do e-mail. A unicidade por pedido faz o alerta cair uma vez. Escrita só por detectar_vendas_abaixo_da_margem e pelo worker do e-mail.';

create unique index sale_margin_alerts_order_unique
  on public.sale_margin_alerts (organization_id, marketplace, order_ref);

create index sale_margin_alerts_email_pending_idx
  on public.sale_margin_alerts (organization_id, detected_at)
  where email_status = 'pending';

create index sale_margin_alerts_org_detected_idx
  on public.sale_margin_alerts (organization_id, detected_at desc);

alter table public.sale_margin_alerts enable row level security;

-- O mesmo alcance de `domain_events`: a conta do ML ou a loja da Shopee.
create policy sale_margin_alerts_select_permitted
  on public.sale_margin_alerts for select to authenticated
  using (
    (ml_account_id is not null and ml_account_id in (select private.accessible_accounts()))
    or (shopee_shop_id is not null and shopee_shop_id in (select private.accessible_shopee_shops()))
  );

revoke all on public.sale_margin_alerts from anon, authenticated;
grant select on public.sale_margin_alerts to authenticated;
grant select, insert, update on public.sale_margin_alerts to service_role;

-- ---------------------------------------------------------------------------
-- 3. O julgamento
-- ---------------------------------------------------------------------------

-- O custo UNITÁRIO do SKU numa data, pela regra de get_sku_margins: o último
-- valor do histórico até a data; sem histórico, o do cadastro; zero é
-- desconhecido. Kit: a soma dos componentes, desconhecido se algum faltar.
create or replace function private.custo_unitario_na_data(p_sku_id uuid, p_em timestamptz)
returns table (custo numeric, atual boolean)
language sql
stable
set search_path = ''
as $$
  with
  sku as (
    select s.id, s.kind, s.purchase_cost from public.skus s where s.id = p_sku_id
  ),
  componentes as (
    select c.component_sku_id, c.quantity
    from public.sku_components c
    where c.kit_sku_id = p_sku_id
      and exists (select 1 from sku where sku.kind = 'KIT')
  ),
  valores as (
    select
      x.alvo,
      x.quantidade,
      nullif(coalesce(h.new_cost, cs.purchase_cost), 0) as unitario,
      coalesce(h.new_cost, 0) <= 0 as atual
    from (
      select c.component_sku_id as alvo, c.quantity::numeric as quantidade from componentes c
      union all
      select sku.id, 1::numeric from sku where not exists (select 1 from componentes)
    ) x
    join public.skus cs on cs.id = x.alvo
    left join lateral (
      select hh.new_cost
      from public.sku_cost_history hh
      where hh.sku_id = x.alvo
        and hh.changed_at <= p_em
      order by hh.changed_at desc, hh.id desc
      limit 1
    ) h on true
  )
  select
    case when count(*) > 0 and bool_and(v.unitario is not null) then sum(v.unitario * v.quantidade) end,
    coalesce(bool_or(v.atual), false)
  from valores v;
$$;

-- A marca conta como importada no próprio SKU ou em qualquer componente do kit.
-- É a marca do FORNECEDOR (`supplier_brand`): `brand` guarda a categoria do
-- UpSeller (D-129) e não serve. SKU sem marca atribuída fica na meta padrão.
create or replace function private.sku_de_marca_importada(p_sku_id uuid, p_chaves text[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.skus s
    where (s.id = p_sku_id
           or s.id in (select c.component_sku_id from public.sku_components c where c.kit_sku_id = p_sku_id))
      and private.chave_da_marca(s.supplier_brand) = any (p_chaves)
  );
$$;

create or replace function public.detectar_vendas_abaixo_da_margem(
  p_organization_id uuid,
  p_agora timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_agora timestamptz := coalesce(p_agora, now());
  v_cfg public.margin_alert_settings;
  v_desde timestamptz;
  v_chaves text[];
  v_julgados_ml integer := 0;
  v_julgados_shopee integer := 0;
  v_novos integer := 0;
  v_eventos integer := 0;
begin
  if p_organization_id is null then
    raise exception 'organizacao obrigatoria' using errcode = '22023';
  end if;

  select * into v_cfg from public.margin_alert_settings s where s.organization_id = p_organization_id;

  if not found or not v_cfg.enabled then
    return jsonb_build_object('ativo', false, 'novos', 0, 'notificadas', 0);
  end if;

  v_desde := greatest(v_cfg.active_since, v_agora - interval '7 days');
  v_chaves := coalesce((
    select array_agg(distinct private.chave_da_marca(b))
    from unnest(v_cfg.imported_brands) b
    where private.chave_da_marca(b) is not null
  ), '{}'::text[]);

  create temporary table if not exists pg_temp.vendas_julgadas (
    marketplace text, ml_account_id uuid, shopee_shop_id uuid, order_ref text, sku_id uuid,
    quantity integer, sold_at timestamptz, sale_value numeric, net_received numeric,
    product_cost numeric, cost_is_current boolean
  ) on commit drop;
  truncate pg_temp.vendas_julgadas;

  -- ============================ Mercado Livre ============================
  insert into pg_temp.vendas_julgadas
  with
  linhas as materialized (
    select l.order_id, l.ml_account_id, l.date_created, l.sku_id, l.quantity,
           l.quantity * l.unit_price as receita,
           l.sale_fee * l.quantity as comissao,
           l.shipping_share as frete,
           count(*) over (partition by l.order_id) as itens
    from public.ml_sales_lines l
    where l.organization_id = p_organization_id
      and l.date_created >= v_desde
      and l.date_created <= v_agora
      and not exists (
        select 1 from public.sale_margin_alerts a
        where a.organization_id = p_organization_id
          and a.marketplace = 'MERCADO_LIVRE'
          and a.order_ref = l.order_id::text
      )
  ),
  unicos as (
    select l.*
    from linhas l
    where l.sku_id is not null
      and l.frete is not null
      and l.comissao is not null
      and l.receita > 0
      and l.itens = 1
  )
  select 'MERCADO_LIVRE', u.ml_account_id, null::uuid, u.order_id::text, u.sku_id,
         u.quantity, u.date_created, u.receita, u.receita - u.comissao - u.frete,
         c.custo * u.quantity, c.atual
  from unicos u
  cross join lateral private.custo_unitario_na_data(u.sku_id, u.date_created) c
  where c.custo is not null;

  get diagnostics v_julgados_ml = row_count;

  -- =============================== Shopee ================================
  -- A classificação do pedido é a de get_shopee_faturamento_pedidos (5U), a
  -- mesma de get_sku_margins: o recebido não é rateado entre itens.
  insert into pg_temp.vendas_julgadas
  select 'SHOPEE', null::uuid, k.shopee_shop_id, k.order_sn, k.sku_unico,
         k.unidades::integer, o.shopee_created_at, k.receita, k.recebido + coalesce(k.ajustes, 0),
         k.custo, coalesce(k.custo_atual, false)
  from public.get_shopee_faturamento_pedidos(
         p_organization_id,
         (v_desde at time zone 'America/Sao_Paulo')::date,
         (v_agora at time zone 'America/Sao_Paulo')::date,
         null) k
  join public.shopee_orders o
    on o.shopee_shop_id = k.shopee_shop_id
   and o.order_sn = k.order_sn
  where k.environment = 'live'
    and k.loja_lida
    and k.coberto
    and k.sku_unico is not null
    and k.receita > 0
    and k.custo is not null
    and o.shopee_created_at >= v_desde
    and o.shopee_created_at <= v_agora
    and not exists (
      select 1 from public.sale_margin_alerts a
      where a.organization_id = p_organization_id
        and a.marketplace = 'SHOPEE'
        and a.order_ref = k.order_sn
    );

  get diagnostics v_julgados_shopee = row_count;

  -- ============================ O veredito ===============================
  with
  julgadas as (
    select
      v.*,
      s.sku as sku_codigo,
      s.title as titulo,
      nullif(btrim(s.supplier_brand), '') as marca,
      private.sku_de_marca_importada(v.sku_id, v_chaves) as importada,
      (v.net_received - v.product_cost) / v.sale_value as margem
    from pg_temp.vendas_julgadas v
    join public.skus s on s.id = v.sku_id and s.organization_id = p_organization_id
  ),
  abaixo as (
    select j.*,
           case when j.importada then v_cfg.imported_min_margin else v_cfg.default_min_margin end as meta
    from julgadas j
  ),
  novos as (
    insert into public.sale_margin_alerts (
      organization_id, marketplace, ml_account_id, shopee_shop_id, order_ref, sku_id, sku, title,
      brand, imported, quantity, sold_at, sale_value, net_received, product_cost, margin,
      min_margin, cost_is_current, detected_at)
    select
      p_organization_id, a.marketplace, a.ml_account_id, a.shopee_shop_id, a.order_ref, a.sku_id,
      a.sku_codigo, a.titulo, a.marca, a.importada, a.quantity, a.sold_at,
      round(a.sale_value, 2), round(a.net_received, 2), round(a.product_cost, 2),
      round(a.margem, 4), a.meta, a.cost_is_current, v_agora
    from abaixo a
    where a.margem < a.meta
    on conflict (organization_id, marketplace, order_ref) do nothing
    returning *
  ),
  eventos as (
    insert into public.domain_events (
      organization_id, ml_account_id, shopee_shop_id, occurred_at, event_type, entity_type,
      entity_id, before, after, severity, source, dedup_key)
    select
      p_organization_id, n.ml_account_id, n.shopee_shop_id, n.sold_at, 'sale.margin.below', 'sku',
      n.sku_id::text,
      null,
      jsonb_build_object(
        'alerta_id', n.id,
        'marketplace', n.marketplace,
        'pedido', n.order_ref,
        'conta', coalesce(
          (select a.label from public.ml_accounts a where a.id = n.ml_account_id),
          (select coalesce(s.shop_name, s.shop_id::text) from public.shopee_shops s where s.id = n.shopee_shop_id)),
        'sku', n.sku,
        'titulo', n.title,
        'marca', n.brand,
        'importada', n.imported,
        'quantidade', n.quantity,
        'valor_venda', n.sale_value,
        'recebido', n.net_received,
        'custo', n.product_cost,
        'margem', n.margin,
        'meta', n.min_margin,
        'custo_atual', n.cost_is_current,
        'vendido_em', n.sold_at),
      'importante', 'system', 'sale.margin.below:' || n.id::text
    from novos n
    where n.sku_id is not null
    on conflict (dedup_key) do nothing
    returning id
  )
  select (select count(*) from novos), (select count(*) from eventos)
  into v_novos, v_eventos;

  return jsonb_build_object(
    'ativo', true,
    'desde', v_desde,
    'ate', v_agora,
    'julgados', jsonb_build_object('mercado_livre', v_julgados_ml, 'shopee', v_julgados_shopee),
    'novos', v_novos,
    'notificadas', v_eventos);
end;
$$;

comment on function public.detectar_vendas_abaixo_da_margem(uuid, timestamptz) is
  'D-858: julga as vendas cobertas dos últimos 7 dias (e depois de margin_alert_settings.active_since) que ainda não foram alertadas: margem = (recebido − custo) ÷ valor de venda, a regra de get_sku_margins (5X) por pedido — ML com uma linha de item, frete e comissão observados; Shopee coberta com um SKU. Abaixo da meta (imported_min_margin para marca importada, senão default_min_margin) grava sale_margin_alerts e um domain_event sale.margin.below (importante), que vira notificação. Pedido sem custo, frete ou com vários produtos não é julgado. Idempotente: o pedido alertado não volta. Só o worker chama (service_role).';

revoke all on function public.detectar_vendas_abaixo_da_margem(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.detectar_vendas_abaixo_da_margem(uuid, timestamptz) to service_role;

revoke all on function private.custo_unitario_na_data(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.sku_de_marca_importada(uuid, text[]) from public, anon, authenticated;
grant execute on function private.custo_unitario_na_data(uuid, timestamptz) to service_role;
grant execute on function private.sku_de_marca_importada(uuid, text[]) to service_role;

-- O julgamento lê os pedidos da Shopee pela mesma função das telas, e quem o
-- chama é o worker (service_role), que até aqui não a executava.
grant execute on function public.get_shopee_faturamento_pedidos(uuid, date, date, uuid[]) to service_role;
