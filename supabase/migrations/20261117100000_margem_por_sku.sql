-- D-720 e D-721: a margem por SKU em todos os marketplaces e a leitura que a
-- avaliação de compra consome.
--
-- 1. `purchase_review_settings` — as preferências de compra da organização. Hoje
--    uma: até quantos dias de vida comercial um SKU é "recente" (sem conclusão
--    por pouca venda). O piso de margem continua em `central_thresholds`
--    (D-410): é o mesmo corte da Central e do Faturamento, e duplicá-lo
--    deixaria as telas discordando.
-- 2. `get_sku_margins` — os SOMATÓRIOS da margem por SKU, por conta do ML, por
--    loja da Shopee, por marketplace e o consolidado, para uma lista de SKUs.
--    A regra de pedido coberto e de custo é a de `get_faturamento` (5F) e de
--    `get_shopee_faturamento_pedidos` (5U), sem reimplementar a da Shopee.
-- A leitura de análise de compra (`get_purchase_analysis`) vem na migration
-- 20261117120000, depois de `supplier_skus`, de que ela depende.
--
-- Tudo `security invoker`: a RLS de quem chama recorta as contas do ML
-- (`accessible_accounts`) e as lojas da Shopee. O consolidado só soma o que o
-- usuário pode ver — nunca dado de conta a que ele não tem acesso.

-- ---------------------------------------------------------------------------
-- 1. Preferências de compra
-- ---------------------------------------------------------------------------

create table public.purchase_review_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  new_product_days integer not null default 60 check (new_product_days between 1 and 365),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.purchase_review_settings is
  'Preferências da avaliação de compra (D-721). new_product_days: até quantos dias desde a 1ª venda (ou do cadastro, se nunca vendeu) o SKU é recente e não recebe recomendação de retirada por vender pouco. Sem linha, vale o default da coluna (60). O piso de margem é central_thresholds.margin_floor (D-410).';

alter table public.purchase_review_settings enable row level security;

create policy purchase_review_settings_select_member
  on public.purchase_review_settings for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.purchase_review_settings from anon, authenticated;
grant select on public.purchase_review_settings to authenticated;
grant select, insert, update on public.purchase_review_settings to service_role;

create or replace function public.set_purchase_review_settings(
  p_organization_id uuid,
  p_new_product_days integer
)
returns public.purchase_review_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.purchase_review_settings;
begin
  if not private.has_org_role(p_organization_id, array['ADMIN']) then
    raise exception 'sem permissao para alterar as preferencias de compra';
  end if;

  insert into public.purchase_review_settings (organization_id, new_product_days, updated_by, updated_at)
  values (p_organization_id, p_new_product_days, (select auth.uid()), now())
  on conflict (organization_id) do update
    set new_product_days = excluded.new_product_days,
        updated_by = excluded.updated_by,
        updated_at = now()
  returning * into result;

  return result;
end;
$$;

comment on function public.set_purchase_review_settings(uuid, integer) is
  'Grava as preferências da avaliação de compra (D-721). Só ADMIN da organização.';

revoke all on function public.set_purchase_review_settings(uuid, integer) from public, anon;
grant execute on function public.set_purchase_review_settings(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Margem por SKU
-- ---------------------------------------------------------------------------

-- As linhas de venda do SKU saem por este índice (a leitura parte dos SKUs, não
-- da janela inteira como o faturamento).
create index if not exists ml_sales_lines_sku_date_idx
  on public.ml_sales_lines (sku_id, date_created)
  where sku_id is not null;

create or replace function public.get_sku_margins(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_date_from date,
  p_date_to date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
set work_mem = '32MB'
as $$
declare
  v_margem_minima numeric;
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido';
  end if;

  if p_date_to - p_date_from > 366 then
    raise exception 'periodo maximo de 366 dias';
  end if;

  if coalesce(cardinality(p_sku_ids), 0) > 500 then
    raise exception 'no maximo 500 skus por leitura';
  end if;

  -- O piso da ORGANIZAÇÃO pedida (D-410); sem linha, os 10% de sempre.
  v_margem_minima := coalesce(
    (select t.margin_floor from public.central_thresholds t where t.organization_id = p_organization_id),
    0.10
  );

  return (
  with
  alvo as materialized (
    select distinct s.id as sku_id
    from public.skus s
    where s.organization_id = p_organization_id
      and s.id = any (coalesce(p_sku_ids, '{}'::uuid[]))
  ),
  -- ======================= Mercado Livre (5F, D-356) =======================
  -- Os pedidos que têm o SKU, e depois TODAS as linhas desses pedidos: a regra
  -- "um item por pedido" (5E) precisa do pedido inteiro, não só da linha do SKU.
  pedidos_alvo as materialized (
    select distinct l.order_id
    from public.ml_sales_lines l
    where l.sku_id in (select a.sku_id from alvo a)
      and l.organization_id = p_organization_id
      and l.date_created >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and l.date_created < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  linhas as materialized (
    select
      l.order_id,
      l.ml_account_id,
      l.date_created,
      l.line_id as item_id,
      l.sku_id,
      l.quantity,
      l.quantity * l.unit_price as receita,
      l.sale_fee * l.quantity as comissao,
      l.shipping_share as frete
    from public.ml_sales_lines l
    where l.order_id in (select p.order_id from pedidos_alvo p)
      and l.organization_id = p_organization_id
  ),
  skus_janela as materialized (
    select distinct l.sku_id from linhas l where l.sku_id is not null
  ),
  componentes as materialized (
    select sc.kit_sku_id, sc.component_sku_id, sc.quantity
    from public.sku_components sc
    where sc.kit_sku_id in (select j.sku_id from skus_janela j)
  ),
  -- O custo na data da venda: o mesmo intervalo [desde, ate) de get_faturamento.
  historico as materialized (
    select t.sku_id, t.desde, t.ate, t.new_cost
    from (
      select
        h.sku_id,
        h.changed_at as desde,
        lead(h.changed_at) over (partition by h.sku_id order by h.changed_at, h.id) as ate,
        h.new_cost
      from public.sku_cost_history h
      where h.sku_id in (
        select j.sku_id from skus_janela j
        union
        select c.component_sku_id from componentes c
      )
    ) t
    where t.desde < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (t.ate is null or t.ate > (p_date_from::timestamp at time zone 'America/Sao_Paulo'))
  ),
  custo_kit as materialized (
    select
      l.item_id,
      count(*) as componentes,
      case when count(*) > 0 and bool_and(v.custo_unitario is not null)
           then sum(v.custo_unitario * c.quantity) end as custo,
      case when bool_and(v.fonte = 'historico') then 'historico' else 'atual' end as fonte
    from linhas l
    join componentes c on c.kit_sku_id = l.sku_id
    join public.skus cs on cs.id = c.component_sku_id
    left join historico hc
      on hc.sku_id = cs.id
     and hc.desde <= l.date_created
     and (hc.ate is null or l.date_created < hc.ate)
    cross join lateral (
      select
        nullif(coalesce(hc.new_cost, cs.purchase_cost), 0) as custo_unitario,
        case
          when coalesce(hc.new_cost, 0) > 0 then 'historico'
          when coalesce(cs.purchase_cost, 0) > 0 then 'atual'
        end as fonte
    ) v
    group by l.item_id
  ),
  custo as (
    select
      l.item_id,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.custo
        else nullif(coalesce(hs.new_cost, s.purchase_cost), 0)
      end * l.quantity as custo,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.fonte
        when coalesce(hs.new_cost, 0) > 0 then 'historico'
        when coalesce(s.purchase_cost, 0) > 0 then 'atual'
      end as fonte
    from linhas l
    join public.skus s on s.id = l.sku_id
    left join historico hs
      on hs.sku_id = s.id
     and hs.desde <= l.date_created
     and (hs.ate is null or l.date_created < hs.ate)
    left join custo_kit k on k.item_id = l.item_id
  ),
  ml_pedido as materialized (
    select
      l.order_id,
      count(*) as itens,
      bool_and(l.comissao is not null) as comissao_ok,
      bool_and(c.custo is not null) as custo_ok,
      bool_or(c.fonte = 'atual') as custo_atual,
      max(l.frete) as frete
    from linhas l
    left join custo c on c.item_id = l.item_id
    group by l.order_id
  ),
  ml_linha as (
    select
      l.sku_id,
      l.ml_account_id,
      l.order_id,
      l.quantity,
      l.receita,
      l.comissao,
      p.frete,
      c.custo,
      p.custo_atual,
      (p.frete is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
    from linhas l
    join ml_pedido p on p.order_id = l.order_id
    left join custo c on c.item_id = l.item_id
    where l.sku_id in (select a.sku_id from alvo a)
  ),
  ml_conta as (
    select
      m.sku_id,
      'MERCADO_LIVRE'::text as marketplace,
      m.ml_account_id as conta_id,
      sum(m.quantity)::bigint as unidades,
      count(distinct m.order_id)::bigint as pedidos,
      sum(m.receita) as receita,
      count(*) filter (where m.coberto)::bigint as pedidos_cobertos,
      sum(m.receita) filter (where m.coberto) as receita_coberta,
      sum(m.receita - m.comissao - m.frete) filter (where m.coberto) as recebido_coberto,
      sum(m.custo) filter (where m.coberto) as custo_coberto,
      count(*) filter (where m.coberto and m.custo_atual)::bigint as pedidos_custo_atual
    from ml_linha m
    group by m.sku_id, m.ml_account_id
  ),
  -- ========================= Shopee (5U, D-437) ============================
  -- A classificação do pedido é a da própria get_shopee_faturamento_pedidos:
  -- loja live lida, financeiro lido, custo de todos os itens, um SKU por
  -- pedido (o recebido não é rateado entre itens).
  shopee as materialized (
    select k.*
    from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, null) k
    where k.environment = 'live'
      and k.loja_lida
      and k.sku_unico in (select a.sku_id from alvo a)
  ),
  shopee_conta as (
    select
      p.sku_unico as sku_id,
      'SHOPEE'::text as marketplace,
      p.shopee_shop_id as conta_id,
      sum(p.unidades)::bigint as unidades,
      count(*)::bigint as pedidos,
      coalesce(sum(p.receita), 0) as receita,
      count(*) filter (where p.coberto)::bigint as pedidos_cobertos,
      sum(p.receita) filter (where p.coberto) as receita_coberta,
      sum(p.recebido + coalesce(p.ajustes, 0)) filter (where p.coberto) as recebido_coberto,
      sum(p.custo) filter (where p.coberto) as custo_coberto,
      count(*) filter (where p.coberto and p.custo_atual)::bigint as pedidos_custo_atual
    from shopee p
    group by p.sku_unico, p.shopee_shop_id
  ),
  contas as (
    select * from ml_conta
    union all
    select * from shopee_conta
  ),
  rotulos as (
    select a.id, a.label as rotulo from public.ml_accounts a where a.organization_id = p_organization_id
    union all
    select s.id, coalesce(s.shop_name, s.shop_id::text) from public.shopee_shops s where s.organization_id = p_organization_id
  ),
  por_marketplace as (
    select
      c.sku_id, c.marketplace,
      sum(c.unidades)::bigint as unidades, sum(c.pedidos)::bigint as pedidos, sum(c.receita) as receita,
      sum(c.pedidos_cobertos)::bigint as pedidos_cobertos,
      sum(c.receita_coberta) as receita_coberta, sum(c.recebido_coberto) as recebido_coberto,
      sum(c.custo_coberto) as custo_coberto, sum(c.pedidos_custo_atual)::bigint as pedidos_custo_atual
    from contas c
    group by c.sku_id, c.marketplace
  ),
  -- O consolidado é a soma dos VALORES — nunca a média das porcentagens.
  total as (
    select
      c.sku_id,
      sum(c.unidades)::bigint as unidades, sum(c.pedidos)::bigint as pedidos, sum(c.receita) as receita,
      sum(c.pedidos_cobertos)::bigint as pedidos_cobertos,
      sum(c.receita_coberta) as receita_coberta, sum(c.recebido_coberto) as recebido_coberto,
      sum(c.custo_coberto) as custo_coberto, sum(c.pedidos_custo_atual)::bigint as pedidos_custo_atual
    from contas c
    group by c.sku_id
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', p_date_from, 'ate', p_date_to),
    'margem_minima', v_margem_minima,
    'canais', jsonb_build_object(
      'mercado_livre', jsonb_build_object(
        'contas', (select count(*) from public.ml_accounts a where a.organization_id = p_organization_id)
      ),
      'shopee', jsonb_build_object(
        'lojas_lidas', (
          select count(*) from public.shopee_shops s
          where s.organization_id = p_organization_id and s.environment = 'live' and s.orders_synced_until is not null
        )
      ),
      -- C-86/D-645: o TikTok Shop só tem a conexão; pedidos e financeiro não são
      -- lidos. Margem do TikTok = indisponível, nunca zero.
      'tiktok_shop', jsonb_build_object(
        'lojas', (select count(*) from public.tiktok_shops t where t.organization_id = p_organization_id),
        'pedidos_lidos', false
      )
    ),
    'skus', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku_id', a.sku_id,
        'total', (
          select jsonb_build_object(
            'unidades', t.unidades, 'pedidos', t.pedidos, 'receita', round(t.receita, 2),
            'pedidos_cobertos', t.pedidos_cobertos,
            'receita_coberta', round(t.receita_coberta, 2),
            'recebido_coberto', round(t.recebido_coberto, 2),
            'custo_coberto', round(t.custo_coberto, 2),
            'pedidos_custo_atual', t.pedidos_custo_atual)
          from total t where t.sku_id = a.sku_id),
        'marketplaces', coalesce((
          select jsonb_agg(jsonb_build_object(
            'marketplace', m.marketplace,
            'unidades', m.unidades, 'pedidos', m.pedidos, 'receita', round(m.receita, 2),
            'pedidos_cobertos', m.pedidos_cobertos,
            'receita_coberta', round(m.receita_coberta, 2),
            'recebido_coberto', round(m.recebido_coberto, 2),
            'custo_coberto', round(m.custo_coberto, 2),
            'pedidos_custo_atual', m.pedidos_custo_atual) order by m.marketplace)
          from por_marketplace m where m.sku_id = a.sku_id), '[]'::jsonb),
        'contas', coalesce((
          select jsonb_agg(jsonb_build_object(
            'marketplace', c.marketplace,
            'conta_id', c.conta_id,
            'conta', r.rotulo,
            'unidades', c.unidades, 'pedidos', c.pedidos, 'receita', round(c.receita, 2),
            'pedidos_cobertos', c.pedidos_cobertos,
            'receita_coberta', round(c.receita_coberta, 2),
            'recebido_coberto', round(c.recebido_coberto, 2),
            'custo_coberto', round(c.custo_coberto, 2),
            'pedidos_custo_atual', c.pedidos_custo_atual) order by c.marketplace, c.receita desc, c.conta_id)
          from contas c left join rotulos r on r.id = c.conta_id
          where c.sku_id = a.sku_id), '[]'::jsonb)
      ) order by a.sku_id)
      from alvo a), '[]'::jsonb)
  )
  );
end;
$$;

comment on function public.get_sku_margins(uuid, uuid[], date, date) is
  'Margem por SKU (D-720): somatórios por conta do ML, loja da Shopee, marketplace e o consolidado (soma dos valores, nunca média de porcentagens), para até 500 SKUs e até 366 dias. Margem = (recebido_coberto − custo_coberto) ÷ receita_coberta, só pedidos cobertos (5F no ML: preço − comissão − frete do vendedor, sem taxa fixa, parcelamento nem Mercado Pago; 5U na Shopee: escrow + ajustes). Custo na data da venda, kit pelos componentes, pedidos_custo_atual = custo do cadastro atual. Pedido da Shopee com vários SKUs não é atribuído (5U). TikTok Shop: só a contagem de lojas, sem pedidos lidos. security invoker: só as contas e lojas que a RLS de quem chama alcança.';

revoke all on function public.get_sku_margins(uuid, uuid[], date, date) from public, anon;
grant execute on function public.get_sku_margins(uuid, uuid[], date, date) to authenticated, service_role;
