-- D-413 — O frete do envio compartilhado conta uma vez.
--
-- O worker grava em cada pedido o que `GET /shipments/{id}/costs` devolve
-- (D-165), e esse custo é do ENVIO. Os pedidos de um pacote dividem o envio:
-- cada um recebia o custo inteiro, e toda soma pedido a pedido -- o
-- faturamento e a central, o ranking de produtos, a margem de /vendas, o
-- detector de frete -- contava esse envio uma vez por pedido.
--
-- MEDIDO (produção, 25/09, 30 dias): 99 envios com dois pedidos pagos. Em 63
-- os dois trazem o MESMO custo: o pacote do Mercado Livre lista os dois
-- pedidos e `/costs` é o do envio inteiro (sonda de 7 envios) -- R$ 1.576,12
-- somados a mais. Em 36 (todos Full) os custos são DIFERENTES: o pacote do
-- envio lista um pedido só, `/costs` bate com esse, e o outro trouxe o seu
-- próprio valor. Não há como provar que é repetição: ficam como vieram.
--
-- A REGRA NUM LUGAR SÓ. `order_financials.seller_shipping_share` é a parte do
-- pedido no frete do vendedor: no mesmo envio, os pedidos válidos com o mesmo
-- custo o dividem na proporção do valor de cada um; o pedido sozinho, com
-- custo diferente dos outros ou cancelado fica com o próprio custo. Gatilhos
-- a mantêm, e `seller_shipping_cost` continua sendo o que o Mercado Livre
-- devolveu. As cinco funções que somavam o custo passam a somar a parte.

alter table public.order_financials
  add column seller_shipping_share numeric;

comment on column public.order_financials.seller_shipping_share is
  'A parte deste pedido no frete do vendedor (D-413): o custo do envio (seller_shipping_cost) dividido entre os pedidos validos do mesmo envio que trazem o mesmo custo, na proporcao do valor de cada um. Pedido sozinho, com custo diferente dos outros ou cancelado: o proprio custo. NULL quando o custo e NULL. Mantida por gatilho; e o que as somas leem.';

-- O que já existe: a parte é o custo. Os envios compartilhados são rateados
-- logo abaixo, quando a função existir. Nenhum gatilho escuta esta coluna
-- ainda, e o detector é refeito no fim só para os pedidos rateados.
update public.order_financials
   set seller_shipping_share = seller_shipping_cost
 where seller_shipping_cost is not null;

-- Achar os outros pedidos do envio a cada frete gravado.
create index orders_shipping_id_idx
  on public.orders (shipping_id)
  where shipping_id is not null;

-- O rateio de UM envio. Proporção do valor do pedido; sem valor em algum, em
-- partes iguais. Seis casas: a soma das partes fecha com o custo a menos de
-- um centavo em qualquer soma exibida.
create or replace function private.ratear_frete_do_envio(p_shipping_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  with grupo as (
    select f.order_id,
           f.seller_shipping_cost as custo,
           o.total_amount as valor,
           o.status in ('paid', 'partially_refunded') as valido
    from public.orders o
    join public.order_financials f on f.order_id = o.id
    where o.shipping_id = p_shipping_id
  ),
  parte as (
    select g.order_id,
           case
             when g.custo is null then null
             when not g.valido or count(*) over w = 1 then g.custo
             when count(g.valor) over w = count(*) over w and min(g.valor) over w > 0
               then round(g.custo * g.valor / sum(g.valor) over w, 6)
             else round(g.custo / count(*) over w, 6)
           end as parte
    from grupo g
    window w as (partition by g.custo, g.valido)
  )
  update public.order_financials f
     set seller_shipping_share = p.parte
    from parte p
   where f.order_id = p.order_id
     and f.seller_shipping_share is distinct from p.parte;
$$;

-- Antes de gravar o frete: a parte começa como o custo. O pedido sozinho no
-- envio -- quase todos -- não precisa de mais nada.
create or replace function private.order_financials_parte_inicial()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.seller_shipping_share := new.seller_shipping_cost;
  return new;
end;
$$;

-- Depois: se o envio tem outro pedido com frete gravado, rateia o envio.
create or replace function private.order_financials_ratear()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_envio bigint;
begin
  select o.shipping_id into v_envio from public.orders o where o.id = new.order_id;

  if v_envio is not null and exists (
    select 1
    from public.orders o
    join public.order_financials f on f.order_id = o.id
    where o.shipping_id = v_envio
      and o.id <> new.order_id
  ) then
    perform private.ratear_frete_do_envio(v_envio);
  end if;

  return null;
end;
$$;

-- O pedido mudou o que o rateio lê: o status (cancelado sai da divisão), o
-- envio ou o valor.
create or replace function private.orders_ratear_frete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.order_financials f where f.order_id = new.id) then
    return null;
  end if;

  if old.shipping_id is not null and old.shipping_id is distinct from new.shipping_id then
    perform private.ratear_frete_do_envio(old.shipping_id);
  end if;

  if new.shipping_id is null then
    update public.order_financials f
       set seller_shipping_share = f.seller_shipping_cost
     where f.order_id = new.id
       and f.seller_shipping_share is distinct from f.seller_shipping_cost;
  else
    perform private.ratear_frete_do_envio(new.shipping_id);
  end if;

  return null;
end;
$$;

-- Nada disto é chamável de fora: só os gatilhos.
revoke all on function private.ratear_frete_do_envio(bigint) from public, anon, authenticated, service_role;
revoke all on function private.order_financials_parte_inicial() from public, anon, authenticated, service_role;
revoke all on function private.order_financials_ratear() from public, anon, authenticated, service_role;
revoke all on function private.orders_ratear_frete() from public, anon, authenticated, service_role;

create trigger order_financials_parte_inicial
  before insert or update of seller_shipping_cost on public.order_financials
  for each row execute function private.order_financials_parte_inicial();

create trigger order_financials_ratear
  after insert or update of seller_shipping_cost on public.order_financials
  for each row execute function private.order_financials_ratear();

-- O webhook regrava `orders` o tempo todo com os mesmos valores: só a mudança
-- do que o rateio lê custa alguma coisa.
create trigger orders_ratear_frete
  after update on public.orders
  for each row
  when (
    old.status is distinct from new.status
    or old.shipping_id is distinct from new.shipping_id
    or old.total_amount is distinct from new.total_amount
  )
  execute function private.orders_ratear_frete();

-- Os envios compartilhados que já existem.
select private.ratear_frete_do_envio(e.shipping_id)
from (
  select o.shipping_id
  from public.orders o
  join public.order_financials f on f.order_id = o.id
  where o.shipping_id is not null
  group by o.shipping_id
  having count(*) > 1
) e;

-- A parte existe exatamente quando o custo existe.
alter table public.order_financials
  add constraint order_financials_parte_do_frete
  check ((seller_shipping_cost is null) = (seller_shipping_share is null)) not valid;

alter table public.order_financials
  validate constraint order_financials_parte_do_frete;

-- ── O detector: a venda leva a parte do pedido ─────────────────────────

create or replace function private.sync_shipping_sale(p_order_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.shipping_sales where order_id = p_order_id;

  insert into public.shipping_sales
    (order_id, organization_id, ml_account_id, date_created, line_id, listing_id, sku_id, title,
     unit_price, sale_fee, shipping_cost)
  select o.id, o.organization_id, o.ml_account_id, o.date_created, i.id, i.item_id, i.sku_id, i.title,
         i.unit_price, i.sale_fee, f.seller_shipping_share
  from public.orders o
  join public.order_financials f on f.order_id = o.id
  join public.order_items i
    on i.order_id = o.id
   and i.organization_id = o.organization_id
   and i.ml_account_id = o.ml_account_id
  where o.id = p_order_id
    and o.status in ('paid', 'partially_refunded')
    and o.logistic_type is distinct from 'self_service'
    and f.seller_shipping_share is not null
    and i.quantity = 1
    and (
      select count(*)
      from public.order_items c
      where c.order_id = o.id
        and c.organization_id = o.organization_id
        and c.ml_account_id = o.ml_account_id
    ) = 1;
end;
$$;

-- A parte mudou: a venda do detector também.
drop trigger shipping_sales_from_financials on public.order_financials;

create trigger shipping_sales_from_financials
  after insert or update of seller_shipping_cost, seller_shipping_share or delete on public.order_financials
  for each row execute function private.shipping_sales_trigger();

-- As vendas já gravadas dos pedidos rateados.
select private.sync_shipping_sale(f.order_id)
from public.order_financials f
where f.seller_shipping_share is distinct from f.seller_shipping_cost;

-- ── As somas: a parte do pedido no lugar do custo do envio ────────────
-- Cópia exata da versão anterior de cada função, com `seller_shipping_cost`
-- trocado por `seller_shipping_share` -- nada mais muda nelas.

-- get_faturamento: versão de 20260923195959 (D-410).
create or replace function public.get_faturamento(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_detalhe boolean default true
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  -- D-410: a margem mínima da organização de quem chama (central_thresholds);
  -- sem linha -- ou sem usuário, como o service_role --, os 10% de sempre.
  v_margem_minima numeric := coalesce((
    select t.margin_floor
    from public.central_thresholds t
    where t.organization_id in (
      select m.organization_id
      from public.organization_members m
      where m.user_id = (select auth.uid())
    )
    order by t.organization_id
    limit 1
  ), 0.10);
begin
  return (
  with bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.pack_id, o.date_created
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  linhas as materialized (
    select
      p.id as order_id,
      p.organization_id,
      p.ml_account_id,
      p.date_created,
      p.pack_id,
      oi.id as item_id,
      oi.sku_id,
      oi.quantity,
      oi.quantity * oi.unit_price as receita,
      oi.sale_fee * oi.quantity as comissao
    from pedidos p
    -- Uma busca por pedido no indice (order_id, position). O `offset 0`
    -- impede a subconsulta de virar join comum: sem ele, o plano custom
    -- varre order_items inteira em hash join (cabecalho, item 3).
    cross join lateral (
      select i.id, i.sku_id, i.quantity, i.unit_price, i.sale_fee
      from public.order_items i
      where i.order_id = p.id
        and i.organization_id = p.organization_id
        and i.ml_account_id = p.ml_account_id
      offset 0
    ) oi
  ),
  skus_janela as materialized (
    select distinct l.sku_id
    from linhas l
    where l.sku_id is not null
  ),
  componentes as materialized (
    select sc.kit_sku_id, sc.component_sku_id, sc.quantity
    from public.sku_components sc
    where sc.kit_sku_id in (select j.sku_id from skus_janela j)
  ),
  -- Cada mudanca de custo vira o intervalo [desde, ate): o item acha o seu
  -- por hash em sku_id + o filtro do intervalo, que e o "ultimo new_cost com
  -- changed_at <= date_created" de D-356. Empate de changed_at: vence o
  -- maior id (o intervalo vazio [t, t) nunca casa).
  --
  -- So ficam os intervalos que CRUZAM a janela (item 6 do cabecalho): o
  -- `lead()` corre sobre o historico inteiro do SKU, e o filtro vem depois,
  -- por fora -- nao desce para dentro da janela de `lead()`, porque `desde`
  -- e `ate` nao sao a particao. As datas sao as de `bounds` repetidas, e nao
  -- uma segunda referencia a `bounds`: CTE citada duas vezes e materializada,
  -- e `pedidos` deixaria de ver as datas como constantes no plano.
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
  -- O pedido e agregado ANTES do frete: `itens` e o count(*) do grupo, e o
  -- frete e o desconto entram uma vez por pedido em `classificado` -- os
  -- mesmos valores que o row_number() = 1 + max() de D-356 davam.
  por_pedido as (
    select
      l.order_id,
      l.organization_id,
      l.ml_account_id,
      (l.date_created at time zone 'America/Sao_Paulo')::date as dia,
      case when l.pack_id is null then 'order:' || l.order_id::text else 'pack:' || l.pack_id::text end as compra,
      sum(l.receita) as receita,
      sum(l.quantity) as unidades,
      sum(l.comissao) as comissao,
      bool_and(l.comissao is not null) as comissao_ok,
      count(*) as itens,
      sum(c.custo) as custo,
      bool_and(c.custo is not null) as custo_ok,
      bool_or(c.fonte = 'atual') as custo_atual,
      bool_or(l.sku_id is null) as sem_sku
    from linhas l
    left join custo c on c.item_id = l.item_id
    group by l.order_id, l.organization_id, l.ml_account_id, l.date_created, l.pack_id
  ),
  -- D-395: a aliquota de imposto vigente em cada dia, em intervalos
  -- [desde, ate) por organizacao. A tabela e minuscula (uma linha por mudanca
  -- de aliquota), e o pedido acha a sua pelo dia de negocio -- o mesmo dia
  -- das demais metricas. Sem aliquota cadastrada para o dia, o imposto do
  -- pedido e NULL, e os totais que dependem dele tambem.
  aliquotas as (
    select
      t.organization_id,
      t.valid_from as desde,
      lead(t.valid_from) over (partition by t.organization_id order by t.valid_from) as ate,
      t.rate
    from public.tax_rates t
  ),
  classificado as materialized (
    select
      p.order_id,
      p.ml_account_id,
      p.dia,
      p.compra,
      p.receita,
      p.unidades,
      p.comissao,
      p.comissao_ok,
      f.seller_shipping_share as frete,
      f.seller_discount as desconto,
      p.itens,
      p.custo,
      p.custo_ok,
      p.custo_atual,
      p.sem_sku,
      a.rate as aliquota,
      p.receita * a.rate as imposto,
      (f.seller_shipping_share is not null and p.comissao_ok) as com_custos,
      (f.seller_shipping_share is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
    from por_pedido p
    left join public.order_financials f on f.order_id = p.order_id
    left join aliquotas a
      on a.organization_id = p.organization_id
     and p.dia >= a.desde
     and (a.ate is null or p.dia < a.ate)
  ),
  resumo as (
    select jsonb_build_object(
      'pedidos', count(*),
      'compras', count(distinct k.compra),
      'unidades', coalesce(sum(k.unidades), 0),
      'receita_bruta', coalesce(round(sum(k.receita), 2), 0),
      'taxas_ml', coalesce(round(sum(k.comissao), 2), 0),
      'ticket_medio', round(sum(k.receita) / nullif(count(distinct k.compra), 0), 2),
      'preco_medio', round(sum(k.receita) / nullif(sum(k.unidades), 0), 2),
      'comissao_percentual', round(sum(k.comissao) / nullif(sum(k.receita), 0), 4),
      'pedidos_com_custos', count(*) filter (where k.com_custos),
      'receita_com_custos', round(sum(k.receita) filter (where k.com_custos), 2),
      'taxas_ml_com_custos', round(sum(k.comissao) filter (where k.com_custos), 2),
      'frete_vendedor', round(sum(k.frete) filter (where k.com_custos), 2),
      'desconto_vendedor', round(sum(k.desconto) filter (where k.com_custos), 2),
      'margem_operacional', round(sum(k.receita - k.comissao - k.frete) filter (where k.com_custos), 2),
      'frete_medio_pedido', round(sum(k.frete) filter (where k.com_custos) / nullif(count(*) filter (where k.com_custos), 0), 2),
      'pedidos_cobertos', count(*) filter (where k.coberto),
      'receita_coberta', round(sum(k.receita) filter (where k.coberto), 2),
      -- Os degraus da cascata, do MESMO subconjunto coberto: a tela nao soma.
      'taxas_ml_cobertas', round(sum(k.comissao) filter (where k.coberto), 2),
      'frete_vendedor_coberto', round(sum(k.frete) filter (where k.coberto), 2),
      'margem_operacional_coberta', round(sum(k.receita - k.comissao - k.frete) filter (where k.coberto), 2),
      'custo_produtos', round(sum(k.custo) filter (where k.coberto), 2),
      'resultado_venda', round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2),
      'margem_venda', round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
        / nullif(sum(k.receita) filter (where k.coberto), 0), 4),
      'pedidos_custo_atual', count(*) filter (where k.coberto and k.custo_atual),
      'pedidos_sem_sku', count(*) filter (where k.sem_sku),
      'pedidos_sem_custo', count(*) filter (where not k.sem_sku and not k.custo_ok),
      'pedidos_sem_frete', count(*) filter (where not k.com_custos),
      'pedidos_multi_item', count(*) filter (where k.itens > 1),
      -- D-395: imposto pela aliquota vigente no dia de cada pedido. So existe
      -- quando TODOS os pedidos do conjunto tem aliquota: somar os que tem e
      -- ignorar os que nao tem daria um imposto menor com cara de exato.
      'pedidos_sem_aliquota', count(*) filter (where k.aliquota is null),
      'aliquota_unica', case
        when count(*) > 0 and bool_and(k.aliquota is not null) and count(distinct k.aliquota) = 1
        then max(k.aliquota) end,
      'imposto_estimado', case
        when count(*) > 0 and bool_and(k.aliquota is not null)
        then round(sum(k.imposto), 2) end,
      'imposto_coberto', case
        when count(*) filter (where k.coberto) > 0 and bool_and(k.aliquota is not null) filter (where k.coberto)
        then round(sum(k.imposto) filter (where k.coberto), 2) end,
      'resultado_apos_imposto', case
        when count(*) filter (where k.coberto) > 0 and bool_and(k.aliquota is not null) filter (where k.coberto)
        then round(sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.coberto), 2) end,
      'margem_apos_imposto', case
        when count(*) filter (where k.coberto) > 0 and bool_and(k.aliquota is not null) filter (where k.coberto)
        then round(
          sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.coberto)
          / nullif(sum(k.receita) filter (where k.coberto), 0), 4) end
    ) as j
    from classificado k
  ),
  diario as (
    select coalesce(jsonb_agg(to_jsonb(d) order by d.dia), '[]'::jsonb) as j
    from (
      select
        k.dia,
        count(*) as pedidos,
        round(sum(k.receita), 2) as receita_bruta,
        round(sum(k.comissao), 2) as taxas_ml,
        round(sum(k.frete) filter (where k.com_custos), 2) as frete_vendedor,
        round(sum(k.receita) filter (where k.coberto), 2) as receita_coberta,
        round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2) as resultado_venda,
        round(
          sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
          / nullif(sum(k.receita) filter (where k.coberto), 0), 4) as margem_venda
      from classificado k
      where p_detalhe
      group by k.dia
    ) d
  ),
  por_conta as (
    select coalesce(jsonb_agg(to_jsonb(c) order by c.receita_bruta desc, c.ml_account_id), '[]'::jsonb) as j
    from (
      select
        k.ml_account_id,
        a.label as conta,
        count(*) as pedidos,
        round(sum(k.receita), 2) as receita_bruta,
        round(sum(k.comissao), 2) as taxas_ml,
        count(*) filter (where k.com_custos) as pedidos_com_custos,
        round(sum(k.frete) filter (where k.com_custos), 2) as frete_vendedor,
        round(sum(k.receita - k.comissao - k.frete) filter (where k.com_custos), 2) as margem_operacional,
        count(*) filter (where k.coberto) as pedidos_cobertos,
        round(sum(k.receita) filter (where k.coberto), 2) as receita_coberta,
        round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2) as resultado_venda,
        round(
          sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
          / nullif(sum(k.receita) filter (where k.coberto), 0), 4) as margem_venda
      from classificado k
      join public.ml_accounts a on a.id = k.ml_account_id
      where p_detalhe
      group by k.ml_account_id, a.label
    ) c
  ),
  por_sku_base as materialized (
    select
      l.sku_id,
      sum(l.quantity) as unidades,
      count(distinct l.order_id) as pedidos,
      round(sum(l.receita), 2) as receita_bruta,
      round(sum(l.comissao), 2) as taxas_ml,
      count(*) filter (where k.coberto) as pedidos_cobertos,
      round(sum(l.receita) filter (where k.coberto), 2) as receita_coberta,
      round(sum(k.frete) filter (where k.coberto), 2) as frete_vendedor,
      round(sum(k.custo) filter (where k.coberto), 2) as custo_produtos,
      round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto), 2) as resultado_venda,
      round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.coberto)
        / nullif(sum(l.receita) filter (where k.coberto), 0), 4) as margem_venda,
      coalesce(bool_or(k.custo_atual) filter (where k.coberto), false) as custo_atual
    from linhas l
    join classificado k on k.order_id = l.order_id
    where p_detalhe
      and l.sku_id is not null
    group by l.sku_id
  ),
  por_sku as (
    select jsonb_build_object(
      'maior_receita', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.receita_bruta desc, x.sku_id), '[]'::jsonb)
        from (
          select b.*, s.sku, s.title
          from por_sku_base b
          join public.skus s on s.id = b.sku_id
          order by b.receita_bruta desc, b.sku_id
          limit 30
        ) x
      ),
      'menor_margem', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.margem_venda, x.receita_coberta desc, x.sku_id), '[]'::jsonb)
        from (
          select b.*, s.sku, s.title
          from por_sku_base b
          join public.skus s on s.id = b.sku_id
          where b.pedidos_cobertos > 0
            and b.margem_venda < v_margem_minima
          order by b.margem_venda, b.receita_coberta desc, b.sku_id
          limit 20
        ) x
      ),
      'skus_com_venda', (select count(*) from por_sku_base),
      -- O nome da chave ficou do tempo em que o corte era fixo; o corte é `margem_minima`.
      'skus_margem_abaixo_10', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < v_margem_minima),
      'skus_margem_negativa', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < 0)
    ) as j
  )
  select jsonb_build_object(
    'resumo', r.j,
    'margem_minima', v_margem_minima,
    'diario', case when p_detalhe then d.j end,
    'por_conta', case when p_detalhe then c.j end,
    'por_sku', case when p_detalhe then s.j end
  )
  from resumo r, diario d, por_conta c, por_sku s
  );
end;
$$;

-- get_ranking_produtos: versão de 20260923195930 (D-403).
create or replace function public.get_ranking_produtos(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_ordem text default 'receita',
  p_limite integer default 50,
  p_offset integer default 0,
  p_anterior_from date default null,
  p_anterior_to date default null,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  -- Sem periodo anterior explicito, o de mesmo tamanho logo antes.
  v_anterior_de date := coalesce(p_anterior_from, p_date_from - (p_date_to - p_date_from + 1));
  v_anterior_ate date := coalesce(p_anterior_to, p_date_from - 1);
  v_corte timestamptz := p_date_from::timestamp at time zone 'America/Sao_Paulo';
begin
  if p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to using errcode = '22023';
  end if;
  if v_anterior_ate < v_anterior_de or v_anterior_ate >= p_date_from then
    raise exception 'periodo anterior invalido: % a %', v_anterior_de, v_anterior_ate using errcode = '22023';
  end if;
  if p_ordem is null or p_ordem not in
     ('receita', 'lucro', 'margem', 'menor_margem', 'volume', 'frete', 'prejuizo', 'crescimento', 'queda_margem') then
    raise exception 'ordem desconhecida: %', p_ordem using errcode = '22023';
  end if;
  if p_limite is null or p_limite < 1 or p_limite > 100 or p_offset is null or p_offset < 0 then
    raise exception 'pagina invalida: limite % offset %', p_limite, p_offset using errcode = '22023';
  end if;

  return (
  -- D-402: as CTEs de custo sao as de get_faturamento (D-356/D-395), sem
  -- mudanca. A janela vai do inicio do periodo anterior ao fim do atual, sem
  -- o intervalo entre os dois (mes atual contra os mesmos dias do anterior),
  -- e o pedido leva `atual` para separar os periodos na agregacao por SKU.
  with bounds as (
    select (v_anterior_de::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to,
           ((v_anterior_ate + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_anterior_ate,
           v_corte as ts_corte
  ),
  pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.pack_id, o.date_created
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (o.date_created < b.ts_anterior_ate or o.date_created >= b.ts_corte)
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
      -- D-403: a sincronização de alertas roda como service_role, sem RLS.
      and (p_organization_id is null or o.organization_id = p_organization_id)
  ),
  linhas as materialized (
    select
      p.id as order_id,
      p.organization_id,
      p.ml_account_id,
      p.date_created,
      p.pack_id,
      oi.id as item_id,
      oi.sku_id,
      oi.quantity,
      oi.quantity * oi.unit_price as receita,
      oi.sale_fee * oi.quantity as comissao
    from pedidos p
    -- Uma busca por pedido no indice (order_id, position). O `offset 0`
    -- impede a subconsulta de virar join comum: sem ele, o plano custom
    -- varre order_items inteira em hash join (cabecalho, item 3).
    cross join lateral (
      select i.id, i.sku_id, i.quantity, i.unit_price, i.sale_fee
      from public.order_items i
      where i.order_id = p.id
        and i.organization_id = p.organization_id
        and i.ml_account_id = p.ml_account_id
      offset 0
    ) oi
  ),
  skus_janela as materialized (
    select distinct l.sku_id
    from linhas l
    where l.sku_id is not null
  ),
  componentes as materialized (
    select sc.kit_sku_id, sc.component_sku_id, sc.quantity
    from public.sku_components sc
    where sc.kit_sku_id in (select j.sku_id from skus_janela j)
  ),
  -- Cada mudanca de custo vira o intervalo [desde, ate): o item acha o seu
  -- por hash em sku_id + o filtro do intervalo, que e o "ultimo new_cost com
  -- changed_at <= date_created" de D-356. Empate de changed_at: vence o
  -- maior id (o intervalo vazio [t, t) nunca casa).
  --
  -- So ficam os intervalos que CRUZAM a janela (item 6 do cabecalho): o
  -- `lead()` corre sobre o historico inteiro do SKU, e o filtro vem depois,
  -- por fora -- nao desce para dentro da janela de `lead()`, porque `desde`
  -- e `ate` nao sao a particao. As datas sao as de `bounds` repetidas, e nao
  -- uma segunda referencia a `bounds`: CTE citada duas vezes e materializada,
  -- e `pedidos` deixaria de ver as datas como constantes no plano.
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
      and (t.ate is null or t.ate > (v_anterior_de::timestamp at time zone 'America/Sao_Paulo'))
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
  -- O pedido e agregado ANTES do frete: `itens` e o count(*) do grupo, e o
  -- frete e o desconto entram uma vez por pedido em `classificado` -- os
  -- mesmos valores que o row_number() = 1 + max() de D-356 davam.
  por_pedido as (
    select
      l.order_id,
      l.organization_id,
      l.ml_account_id,
      (l.date_created at time zone 'America/Sao_Paulo')::date as dia,
      case when l.pack_id is null then 'order:' || l.order_id::text else 'pack:' || l.pack_id::text end as compra,
      sum(l.receita) as receita,
      sum(l.quantity) as unidades,
      sum(l.comissao) as comissao,
      bool_and(l.comissao is not null) as comissao_ok,
      count(*) as itens,
      sum(c.custo) as custo,
      bool_and(c.custo is not null) as custo_ok,
      bool_or(c.fonte = 'atual') as custo_atual,
      bool_or(l.sku_id is null) as sem_sku,
      l.date_created >= v_corte as atual
    from linhas l
    left join custo c on c.item_id = l.item_id
    group by l.order_id, l.organization_id, l.ml_account_id, l.date_created, l.pack_id
  ),
  -- D-395: a aliquota de imposto vigente em cada dia, em intervalos
  -- [desde, ate) por organizacao. A tabela e minuscula (uma linha por mudanca
  -- de aliquota), e o pedido acha a sua pelo dia de negocio -- o mesmo dia
  -- das demais metricas. Sem aliquota cadastrada para o dia, o imposto do
  -- pedido e NULL, e os totais que dependem dele tambem.
  aliquotas as (
    select
      t.organization_id,
      t.valid_from as desde,
      lead(t.valid_from) over (partition by t.organization_id order by t.valid_from) as ate,
      t.rate
    from public.tax_rates t
  ),
  classificado as materialized (
    select
      p.order_id,
      p.ml_account_id,
      p.dia,
      p.compra,
      p.receita,
      p.unidades,
      p.comissao,
      p.comissao_ok,
      f.seller_shipping_share as frete,
      f.seller_discount as desconto,
      p.itens,
      p.custo,
      p.custo_ok,
      p.custo_atual,
      p.sem_sku,
      p.atual,
      a.rate as aliquota,
      p.receita * a.rate as imposto,
      (f.seller_shipping_share is not null and p.comissao_ok) as com_custos,
      (f.seller_shipping_share is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
    from por_pedido p
    left join public.order_financials f on f.order_id = p.order_id
    left join aliquotas a
      on a.organization_id = p.organization_id
     and p.dia >= a.desde
     and (a.ate is null or p.dia < a.ate)
  ),
  -- Por SKU, os dois periodos numa agregacao. Resultado e margem SO sobre
  -- pedidos cobertos, como em get_faturamento: o teste de integracao confere
  -- a igualdade do periodo atual com o `por_sku` de la.
  por_sku as materialized (
    select
      l.sku_id,
      sum(l.quantity) filter (where k.atual) as unidades,
      count(distinct l.order_id) filter (where k.atual) as pedidos,
      round(sum(l.receita) filter (where k.atual), 2) as receita_bruta,
      round(sum(l.comissao) filter (where k.atual), 2) as taxas_ml,
      count(*) filter (where k.atual and k.coberto) as pedidos_cobertos,
      round(sum(l.receita) filter (where k.atual and k.coberto), 2) as receita_coberta,
      round(sum(l.comissao) filter (where k.atual and k.coberto), 2) as taxas_ml_cobertas,
      round(sum(k.frete) filter (where k.atual and k.coberto), 2) as frete_vendedor,
      round(sum(k.custo) filter (where k.atual and k.coberto), 2) as custo_produtos,
      round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.atual and k.coberto), 2) as resultado_venda,
      round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where k.atual and k.coberto)
        / nullif(sum(k.receita) filter (where k.atual and k.coberto), 0), 4) as margem_venda,
      -- D-395: imposto so quando TODO pedido coberto do SKU tem aliquota.
      case
        when count(*) filter (where k.atual and k.coberto) > 0
         and bool_and(k.aliquota is not null) filter (where k.atual and k.coberto)
        then round(sum(k.imposto) filter (where k.atual and k.coberto), 2)
      end as imposto,
      case
        when count(*) filter (where k.atual and k.coberto) > 0
         and bool_and(k.aliquota is not null) filter (where k.atual and k.coberto)
        then round(sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.atual and k.coberto), 2)
      end as resultado_apos_imposto,
      case
        when count(*) filter (where k.atual and k.coberto) > 0
         and bool_and(k.aliquota is not null) filter (where k.atual and k.coberto)
        then round(
          sum(k.receita - k.comissao - k.frete - k.custo - k.imposto) filter (where k.atual and k.coberto)
          / nullif(sum(k.receita) filter (where k.atual and k.coberto), 0), 4)
      end as margem_apos_imposto,
      coalesce(bool_or(k.custo_atual) filter (where k.atual and k.coberto), false) as custo_atual,
      count(distinct l.order_id) filter (where not k.atual) as pedidos_anterior,
      sum(l.quantity) filter (where not k.atual) as unidades_anterior,
      round(sum(l.receita) filter (where not k.atual), 2) as receita_anterior,
      count(*) filter (where not k.atual and k.coberto) as pedidos_cobertos_anterior,
      round(sum(k.receita - k.comissao - k.frete - k.custo) filter (where not k.atual and k.coberto), 2) as resultado_anterior,
      round(
        sum(k.receita - k.comissao - k.frete - k.custo) filter (where not k.atual and k.coberto)
        / nullif(sum(k.receita) filter (where not k.atual and k.coberto), 0), 4) as margem_anterior
    from linhas l
    join classificado k on k.order_id = l.order_id
    where l.sku_id is not null
    group by l.sku_id
  ),
  -- So os SKUs que venderam no periodo. Crescimento e queda de margem so com
  -- 5 pedidos nos dois periodos (5 cobertos, para a margem): com menos, uma
  -- venda a mais vira +100%.
  atual as materialized (
    select
      b.*,
      case when b.pedidos >= 5 and b.pedidos_anterior >= 5
           then round(b.receita_bruta / nullif(b.receita_anterior, 0) - 1, 4) end as variacao_receita,
      case when b.pedidos_cobertos >= 5 and b.pedidos_cobertos_anterior >= 5
           then round(b.margem_venda - b.margem_anterior, 4) end as variacao_margem,
      round(b.frete_vendedor / nullif(b.receita_coberta, 0), 4) as frete_sobre_receita
    from por_sku b
    where b.pedidos > 0
  ),
  -- Quantos SKUs, dos de maior resultado, somam metade do resultado de todos.
  -- Sem resultado positivo no total, NULL.
  concentracao as (
    select min(c.posicao) as skus
    from (
      select
        row_number() over (order by a.resultado_venda desc, a.sku_id) as posicao,
        sum(a.resultado_venda) over (order by a.resultado_venda desc, a.sku_id) as acumulado,
        sum(a.resultado_venda) over () as total
      from atual a
      where a.resultado_venda is not null
    ) c
    where c.total > 0
      and c.acumulado >= c.total / 2
  ),
  -- A ordem pedida vira uma chave so, decrescente. "Maior margem" exige 3
  -- pedidos cobertos (uma venda so no topo nao diz nada); "menor margem" e
  -- "prejuizo" nao: uma venda com prejuizo ja e o que se quer ver.
  filtrado as materialized (
    select
      a.*,
      case p_ordem
        when 'receita' then a.receita_bruta
        when 'lucro' then a.resultado_venda
        when 'margem' then a.margem_venda
        when 'menor_margem' then -a.margem_venda
        when 'volume' then a.unidades
        when 'frete' then a.frete_vendedor
        when 'prejuizo' then -a.resultado_venda
        when 'crescimento' then a.variacao_receita
        when 'queda_margem' then -a.variacao_margem
      end as chave
    from atual a
    where case p_ordem
      when 'lucro' then a.resultado_venda is not null
      when 'margem' then a.margem_venda is not null and a.pedidos_cobertos >= 3
      when 'menor_margem' then a.margem_venda is not null
      when 'frete' then a.frete_vendedor > 0
      when 'prejuizo' then a.resultado_venda < 0
      when 'crescimento' then a.variacao_receita is not null
      when 'queda_margem' then a.variacao_margem < 0
      else true
    end
  ),
  pagina as (
    select f.*, s.sku, s.title
    from filtrado f
    join public.skus s on s.id = f.sku_id
    order by f.chave desc, f.receita_bruta desc, f.sku_id
    limit p_limite offset p_offset
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object(
      'inicio', p_date_from,
      'fim', p_date_to,
      'anterior_inicio', v_anterior_de,
      'anterior_fim', v_anterior_ate
    ),
    'ordem', p_ordem,
    'resumo', (
      select jsonb_build_object(
        'skus_com_venda', count(*),
        -- Os totais dos itens com SKU, para dar contexto ao crescimento de cada um.
        'receita_bruta', (select round(sum(b.receita_bruta), 2) from por_sku b),
        'receita_bruta_anterior', (select round(sum(b.receita_anterior), 2) from por_sku b),
        'skus_cobertos', count(*) filter (where a.pedidos_cobertos > 0),
        'resultado_venda', round(sum(a.resultado_venda), 2),
        'skus_prejuizo', count(*) filter (where a.resultado_venda < 0),
        'prejuizo', round(sum(a.resultado_venda) filter (where a.resultado_venda < 0), 2),
        'skus_margem_abaixo_10', count(*) filter (where a.margem_venda < 0.10),
        'skus_comparaveis', count(*) filter (where a.variacao_receita is not null),
        'skus_crescendo', count(*) filter (where a.variacao_receita >= 0.30),
        'skus_margem_comparavel', count(*) filter (where a.variacao_margem is not null),
        'skus_queda_margem', count(*) filter (where a.variacao_margem <= -0.05),
        'skus_metade_do_resultado', (select c.skus from concentracao c)
      )
      from atual a
    ),
    'total', (select count(*) from filtrado),
    'itens', (
      select coalesce(jsonb_agg(to_jsonb(p) - 'chave' order by p.chave desc, p.receita_bruta desc, p.sku_id), '[]'::jsonb)
      from pagina p
    )
  )
  );
end;
$$;

-- get_sales_margin_summary: versão de 20260915210000 (D-356).
create or replace function public.get_sales_margin_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  orders_total bigint,
  orders_covered bigint,
  gross_revenue_covered numeric,
  taxas_ml_covered numeric,
  frete_vendedor numeric,
  desconto_vendedor numeric,
  margem_operacional numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recorte as (select (p_supplier_brand is null and not p_sem_marca) as sem_recorte),
  bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  valid_orders as (
    select o.id, o.total_amount
    from public.orders o
    cross join bounds b
    where (select sem_recorte from recorte)
      and o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  covered as (
    select v.id, v.total_amount, f.seller_shipping_share, f.seller_discount
    from valid_orders v
    join public.order_financials f on f.order_id = v.id
    -- D-356: so o frete decide a cobertura; o desconto ja esta no preco.
    where f.seller_shipping_share is not null
  ),
  fees as (
    -- D-356: a tarifa e por unidade.
    select coalesce(sum(oi.sale_fee * oi.quantity), 0) as taxas
    from public.order_items oi
    join covered c on oi.order_id = c.id
  ),
  totals as (
    select count(*) as n,
           coalesce(round(sum(c.total_amount), 2), 0) as gross,
           coalesce(round(sum(c.seller_shipping_share), 2), 0) as frete,
           -- Informativo (D-356): soma so o que foi observado.
           round(sum(c.seller_discount), 2) as desconto
    from covered c
  )
  select
    case when r.sem_recorte then (select count(*) from valid_orders)::bigint end as orders_total,
    case when r.sem_recorte then totals.n::bigint end as orders_covered,
    case when r.sem_recorte and totals.n > 0 then totals.gross end as gross_revenue_covered,
    case when r.sem_recorte and totals.n > 0 then round(fees.taxas, 2) end as taxas_ml_covered,
    case when r.sem_recorte and totals.n > 0 then totals.frete end as frete_vendedor,
    case when r.sem_recorte and totals.n > 0 then totals.desconto end as desconto_vendedor,
    case when r.sem_recorte and totals.n > 0
         then round(totals.gross - fees.taxas - totals.frete, 2) end as margem_operacional
  from fees, totals, recorte r
$$;

-- ── Quem paga o frete: uma linha por cobrança ─────────────────────────

create or replace function public.get_quem_paga_frete(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_de timestamptz := (p_date_from::timestamp at time zone 'America/Sao_Paulo');
  v_ate timestamptz := ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo');
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido' using errcode = '22023';
  end if;

  return (
  with envios as materialized (
    -- Uma linha por COBRANÇA (D-413): os pedidos de um envio que trazem o
    -- mesmo frete do vendedor são o custo do envio repetido e contam uma vez
    -- (a linha com o detalhe, se houver); fretes diferentes no mesmo envio
    -- são cobranças diferentes e somam -- a regra de `seller_shipping_share`.
    select distinct on (o.shipping_id, f.seller_shipping_cost)
      o.shipping_id,
      coalesce(o.logistic_type, 'desconhecida') as logistica,
      f.shipping_list_cost as cheio,
      f.seller_shipping_cost as vendedor,
      f.seller_shipping_subsidy as ml_vendedor,
      f.buyer_shipping_cost as comprador,
      f.buyer_shipping_subsidy as ml_comprador
    from public.orders o
    join public.order_financials f on f.order_id = o.id
    where o.date_created >= v_de
      and o.date_created < v_ate
      and o.status in ('paid', 'partially_refunded')
      and o.shipping_id is not null
      and f.seller_shipping_cost is not null
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
    order by o.shipping_id, f.seller_shipping_cost, (f.shipping_list_cost is null), o.id
  ),
  com_detalhe as materialized (
    select e.*,
           abs(e.cheio - (e.vendedor + e.ml_vendedor + e.comprador + e.ml_comprador)) >= 0.015 as nao_fecha
    from envios e
    where e.cheio is not null
      and e.ml_vendedor is not null
      and e.comprador is not null
      and e.ml_comprador is not null
  ),
  por_logistica as (
    select
      d.logistica,
      count(distinct d.shipping_id) as envios,
      round(sum(d.vendedor + d.ml_vendedor), 2) as frete_do_vendedor,
      round(sum(d.vendedor), 2) as vendedor_pagou,
      round(sum(d.ml_vendedor), 2) as ml_bancou_vendedor,
      round(sum(d.comprador), 2) as comprador_pagou,
      round(sum(d.ml_comprador), 2) as ml_bancou_comprador,
      count(distinct d.shipping_id) filter (where d.comprador = 0) as frete_gratis_comprador
    from com_detalhe d
    group by d.logistica
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', p_date_from, 'ate', p_date_to),
    -- O primeiro dia com o detalhe gravado, no alcance de quem chama.
    'detalhe_desde', (
      select min((o.date_created at time zone 'America/Sao_Paulo')::date)
      from public.order_financials f
      join public.orders o on o.id = f.order_id
      where f.shipping_list_cost is not null
        and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
    ),
    'envios_com_frete', (select count(distinct e.shipping_id) from envios e),
    'envios_com_detalhe', (select count(distinct d.shipping_id) from com_detalhe d),
    'frete_cheio', (select round(sum(d.cheio), 2) from com_detalhe d),
    -- A parte do vendedor antes do desconto: o que ele pagou mais o que o
    -- Mercado Livre bancou dela.
    'frete_do_vendedor', (select round(sum(d.vendedor + d.ml_vendedor), 2) from com_detalhe d),
    'vendedor_pagou', (select round(sum(d.vendedor), 2) from com_detalhe d),
    'ml_bancou_vendedor', (select round(sum(d.ml_vendedor), 2) from com_detalhe d),
    'comprador_pagou', (select round(sum(d.comprador), 2) from com_detalhe d),
    'ml_bancou_comprador', (select round(sum(d.ml_comprador), 2) from com_detalhe d),
    'frete_gratis_comprador', (select count(distinct d.shipping_id) from com_detalhe d where d.comprador = 0),
    'nao_fecham', (select count(distinct d.shipping_id) from com_detalhe d where d.nao_fecha),
    'por_logistica', (
      select coalesce(jsonb_agg(to_jsonb(l) order by l.envios desc, l.logistica), '[]'::jsonb)
      from por_logistica l
    )
  )
  );
end;
$$;

-- ── O catálogo: o frete do vendedor é a parte do pedido ────────────────

update public.metric_definitions
   set formula = 'SUM(order_financials.seller_shipping_share) sobre pedidos cobertos: a parte do pedido no frete do envio (D-413)',
       source = 'GET /shipments/{id}/costs → senders[].cost somado (§2.15), persistido por D-165 em seller_shipping_cost; seller_shipping_share divide o custo do envio entre os pedidos que o repetem (D-413)',
       inclusions = 'Pedidos válidos com o custo OBSERVADO. Os pedidos válidos de um envio que trazem o mesmo custo dividem esse custo, na proporção do valor de cada um.',
       definition_updated_on = date '2026-09-25'
 where id = 'frete_vendedor';

update public.metric_definitions
   set source = 'order_financials.seller_shipping_share (D-165, D-413)',
       definition_updated_on = date '2026-09-25'
 where id = 'frete_medio_pedido';
