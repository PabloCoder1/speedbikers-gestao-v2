-- ============================================================
-- D-395 - Central do negocio: meta mensal, projecao de fechamento e imposto
--
-- Segunda fatia da central (D-394). Tres pecas, todas pedidas pelo dono em
-- 23/09 ("imposto: aliquota unica sobre o faturamento, com vigencia"):
--
-- 1. `monthly_goals` -- a meta de faturamento de cada mes, da organizacao
--    inteira. Uma linha por mes; escrita ADMIN/GESTOR, leitura de membro
--    (o padrao de replenishment_settings, D-144: leitura pela forma de CONJUNTO
--    de D-181, `organization_id in (select private.accessible_orgs())`, e escrita
--    por has_org_role de 20260901135046).
--
-- 2. `tax_rates` -- a aliquota efetiva sobre o faturamento, com vigencia: a
--    linha vale de `valid_from` ate a proxima. Mudar a aliquota e criar uma
--    linha nova; o passado continua calculado com a aliquota do passado.
--    ZERO linhas semeadas: sem aliquota, o imposto e NULL, nunca 0%.
--
-- 3. `get_faturamento` ganha o imposto pedido a pedido (aliquota do dia da
--    venda) e o resultado/margem apos imposto, no MESMO subconjunto coberto.
--    O corpo e o de 20260918160000 com quatro acrescimos marcados "D-395"
--    (organization_id carregado ate `classificado`, a CTE `aliquotas`, o join
--    e os campos novos do resumo). Nenhum campo existente muda.
--
-- 4. `get_meta_do_mes` -- realizado, ritmo contra a meta e a projecao do
--    fechamento, tudo em SQL sobre `daily_account_metrics`:
--    - perfil semanal: media de cada dia da semana nas 8 semanas completas
--      ate ontem, dividida pela media dos sete (sabado que vende 60% da media
--      tem fator 0,6);
--    - ritmo: receita dos ultimos N dias dividida pela soma dos fatores
--      desses dias (N = 7, 14, 28) -- o nivel "dessazonalizado";
--    - projecao = realizado ate ontem + ritmo x soma dos fatores dos dias
--      restantes (hoje entra pela media, nao pelo parcial). Ritmo atual usa
--      28 dias; conservador e otimista, o menor e o maior ritmo entre 7, 14 e
--      28 dias -- a tendencia recente, dita como faixa;
--    - esperado ate ontem = meta x fatores dos dias completos / fatores do mes
--      (o domingo fraco nao conta como atraso);
--    - mesmo mes do ano anterior, so quando o historico cobre o mes inteiro:
--      conferencia sazonal, nao motor.
--    Eventos comerciais (Black Friday etc.) NAO entram: nao ha calendario.
--
-- 5. Onze definicoes no catalogo (METRICS 5J e 5K).
-- ============================================================

-- ─── 1. Metas mensais ─────────────────────────────────────────

create table public.monthly_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  revenue_goal numeric(14,2) not null check (revenue_goal > 0),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monthly_goals_org_month_key unique (organization_id, month)
);

create trigger monthly_goals_set_updated_at
  before update on public.monthly_goals
  for each row execute function private.set_updated_at();

alter table public.monthly_goals enable row level security;

create policy monthly_goals_select_member
  on public.monthly_goals for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy monthly_goals_insert_admin
  on public.monthly_goals for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy monthly_goals_update_admin
  on public.monthly_goals for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy monthly_goals_delete_admin
  on public.monthly_goals for delete to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.monthly_goals from anon, authenticated;
grant select, insert, update, delete on public.monthly_goals to authenticated;
grant all on public.monthly_goals to service_role;

comment on table public.monthly_goals is
  'Meta de faturamento do mes (D-395), da organizacao inteira: uma linha por mes (month = dia 1). Comparada com a receita bruta das vendas validas (METRICS 5.2) em get_meta_do_mes. Escrita ADMIN/GESTOR. Sem linha, o mes nao tem meta -- a projecao continua existindo.';

-- ─── 2. Aliquota de imposto com vigencia ──────────────────────

create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  valid_from date not null,
  rate numeric(7,5) not null check (rate >= 0 and rate < 1),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_rates_org_valid_from_key unique (organization_id, valid_from)
);

create trigger tax_rates_set_updated_at
  before update on public.tax_rates
  for each row execute function private.set_updated_at();

alter table public.tax_rates enable row level security;

create policy tax_rates_select_member
  on public.tax_rates for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy tax_rates_insert_admin
  on public.tax_rates for insert to authenticated
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy tax_rates_update_admin
  on public.tax_rates for update to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']))
  with check (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

create policy tax_rates_delete_admin
  on public.tax_rates for delete to authenticated
  using (private.has_org_role(organization_id, array['ADMIN','GESTOR']));

revoke all on public.tax_rates from anon, authenticated;
grant select, insert, update, delete on public.tax_rates to authenticated;
grant all on public.tax_rates to service_role;

comment on table public.tax_rates is
  'Aliquota efetiva de imposto sobre o faturamento (D-395), com vigencia: a linha vale de valid_from ate a proxima valid_from da organizacao. rate e fracao (0.06 = 6%). Aplicada pedido a pedido pelo dia de negocio em get_faturamento. ZERO linhas semeadas: sem aliquota o imposto e NULL, nunca zero.';

-- ─── 3. get_faturamento com imposto ───────────────────────────

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
      f.seller_shipping_cost as frete,
      f.seller_discount as desconto,
      p.itens,
      p.custo,
      p.custo_ok,
      p.custo_atual,
      p.sem_sku,
      a.rate as aliquota,
      p.receita * a.rate as imposto,
      (f.seller_shipping_cost is not null and p.comissao_ok) as com_custos,
      (f.seller_shipping_cost is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
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
            and b.margem_venda < 0.10
          order by b.margem_venda, b.receita_coberta desc, b.sku_id
          limit 20
        ) x
      ),
      'skus_com_venda', (select count(*) from por_sku_base),
      'skus_margem_abaixo_10', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < 0.10),
      'skus_margem_negativa', (select count(*) from por_sku_base where pedidos_cobertos > 0 and margem_venda < 0)
    ) as j
  )
  select jsonb_build_object(
    'resumo', r.j,
    'diario', case when p_detalhe then d.j end,
    'por_conta', case when p_detalhe then c.j end,
    'por_sku', case when p_detalhe then s.j end
  )
  from resumo r, diario d, por_conta c, por_sku s
  );
end;
$$;

comment on function public.get_faturamento(date, date, uuid, boolean) is
  'Faturamento de um periodo (D-356): receita, comissao (sale_fee * quantity), frete do vendedor (o desconto e informativo: ja esta no preco), custo do produto na data da venda (kit = soma dos componentes) e margem, numa passada so. Resultado e margem SO sobre pedidos cobertos (frete observado, custo conhecido, uma linha de item), com a cobertura devolvida junto; o que nao e observado volta NULL, nunca zero. Desde D-395 o resumo traz o imposto estimado pela aliquota vigente no dia de cada pedido (tax_rates), o resultado e a margem apos imposto -- NULL quando algum pedido do conjunto nao tem aliquota. Nao e lucro liquido: taxa fixa, parcelamento, custo do Mercado Pago, reembolsos, Ads e custos fixos ficam fora. p_detalhe = false devolve so o resumo. plpgsql com plano custom, order_items por pedido e o custo por SKU numa CTE de intervalos. security invoker.';

revoke all on function public.get_faturamento(date, date, uuid, boolean) from public, anon;
grant execute on function public.get_faturamento(date, date, uuid, boolean) to authenticated, service_role;

-- ─── 4. Meta do mes e projecao ────────────────────────────────

create or replace function public.get_meta_do_mes(
  p_organization_id uuid,
  p_mes date default null,
  p_hoje date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_ini date;
  v_fim date;
  v_ontem date;
  v_historico date;
  v_ini_janela date;
  v_ano_ini date;
  v_ano_fim date;
begin
  v_ini := date_trunc('month', coalesce(p_mes, v_hoje)::timestamp)::date;
  v_fim := (v_ini + interval '1 month' - interval '1 day')::date;
  v_ontem := v_hoje - 1;
  v_ano_ini := (v_ini - interval '1 year')::date;
  v_ano_fim := (v_ano_ini + interval '1 month' - interval '1 day')::date;

  -- O primeiro dia com venda: antes dele "sem linha" nao e "vendeu zero".
  select min(d.metric_date) into v_historico
  from public.daily_account_metrics d
  where d.organization_id = p_organization_id;

  -- As 8 semanas completas ate ontem, cortadas no inicio do historico. Sem
  -- historico nenhum nao ha janela: `greatest` ignoraria o NULL e inventaria
  -- 56 dias de venda zero, e a projecao sairia R$ 0,00 em vez de NULL.
  v_ini_janela := case when v_historico is not null then greatest(v_ontem - 55, v_historico) end;

  return (
    with
    receita_dia as materialized (
      select d.metric_date as dia, sum(d.gross_revenue) as receita
      from public.daily_account_metrics d
      where d.organization_id = p_organization_id
        and (d.metric_date between v_ini_janela and v_ontem
             or d.metric_date between v_ini and v_fim
             or d.metric_date between v_ano_ini and v_ano_fim)
      group by d.metric_date
    ),
    -- Dia sem linha DENTRO do historico e dia sem venda: o rollup so grava
    -- dia com venda (units_sold > 0).
    janela as materialized (
      select g.dia::date as dia, extract(isodow from g.dia)::int as dow, coalesce(r.receita, 0) as receita
      from generate_series(v_ini_janela::timestamp, v_ontem::timestamp, interval '1 day') g(dia)
      left join receita_dia r on r.dia = g.dia::date
    ),
    perfil as (
      select j.dow, avg(j.receita) as media, count(*) as n
      from janela j
      group by j.dow
    ),
    -- O perfil so vale com os sete dias da semana, cada um visto duas vezes
    -- ou mais; senao todo dia pesa 1 e a tela diz que o perfil e plano.
    perfil_ok as (
      select (count(*) = 7 and coalesce(min(p.n), 0) >= 2 and coalesce(avg(p.media), 0) > 0) as ok,
             avg(p.media) as media_geral
      from perfil p
    ),
    fatores as materialized (
      select g.dow, case when po.ok then p.media / po.media_geral else 1 end as fator
      from generate_series(1, 7) g(dow)
      cross join perfil_ok po
      left join perfil p on p.dow = g.dow
    ),
    -- Ritmo dessazonalizado dos ultimos N dias; so existe com os N dias
    -- inteiros dentro do historico.
    niveis as (
      select k.dias,
             case when count(j.dia) = k.dias and sum(f.fator) > 0 then sum(j.receita) / sum(f.fator) end as nivel
      from (values (7), (14), (28)) k(dias)
      left join janela j on j.dia > v_ontem - k.dias
      left join fatores f on f.dow = j.dow
      group by k.dias
    ),
    dias_mes as (
      select g.dia::date as dia, extract(isodow from g.dia)::int as dow
      from generate_series(v_ini::timestamp, v_fim::timestamp, interval '1 day') g(dia)
    ),
    mes as (
      select
        count(*) as dias_no_mes,
        count(*) filter (where dm.dia < v_hoje) as dias_completos,
        count(*) filter (where dm.dia >= v_hoje) as dias_restantes,
        coalesce(sum(r.receita) filter (where dm.dia < v_hoje), 0) as ate_ontem,
        coalesce(sum(r.receita) filter (where dm.dia = v_hoje), 0) as hoje,
        coalesce(sum(r.receita) filter (where dm.dia <= v_hoje), 0) as realizado,
        coalesce(sum(f.fator) filter (where dm.dia < v_hoje), 0) as f_passado,
        coalesce(sum(f.fator) filter (where dm.dia >= v_hoje), 0) as f_restante,
        sum(f.fator) as f_mes
      from dias_mes dm
      join fatores f on f.dow = dm.dow
      left join receita_dia r on r.dia = dm.dia
    ),
    ano as (
      select
        sum(r.receita) as total,
        coalesce(sum(r.receita) filter (where r.dia <= (v_ontem - interval '1 year')::date), 0) as ate_dia
      from receita_dia r
      where r.dia between v_ano_ini and v_ano_fim
    ),
    calc as (
      select
        m.*,
        (select g.revenue_goal from public.monthly_goals g
          where g.organization_id = p_organization_id and g.month = v_ini) as meta,
        (select n.nivel from niveis n where n.dias = 7) as n7,
        (select n.nivel from niveis n where n.dias = 14) as n14,
        (select n.nivel from niveis n where n.dias = 28) as n28,
        (select po.ok from perfil_ok po) as perfil_semanal,
        case when v_fim < v_hoje then 'encerrado' when v_ini > v_hoje then 'futuro' else 'em_curso' end as situacao
      from mes m
    ),
    final as (
      select
        c.*,
        coalesce(c.n28, c.n14, c.n7) as nivel,
        least(c.n7, c.n14, c.n28) as nivel_min,
        greatest(c.n7, c.n14, c.n28) as nivel_max,
        case when c.meta is not null and c.f_mes > 0 then c.meta * c.f_passado / c.f_mes end as esperado
      from calc c
    )
    select jsonb_build_object(
      'mes', v_ini,
      'fim', v_fim,
      'hoje', v_hoje,
      'situacao', x.situacao,
      'inicio_historico', v_historico,
      'meta', x.meta,
      'realizado', case when x.situacao <> 'futuro' then round(x.realizado, 2) end,
      'realizado_ate_ontem', case when x.situacao = 'em_curso' then round(x.ate_ontem, 2) end,
      'realizado_hoje', case when x.situacao = 'em_curso' then round(x.hoje, 2) end,
      'dias_no_mes', x.dias_no_mes,
      'dias_completos', case when x.situacao = 'em_curso' then x.dias_completos end,
      'dias_restantes', case when x.situacao = 'em_curso' then x.dias_restantes end,
      'atingimento', case when x.situacao <> 'futuro' and x.meta > 0 then round(x.realizado / x.meta, 4) end,
      'faltam', case when x.situacao <> 'futuro' and x.meta is not null then round(greatest(x.meta - x.realizado, 0), 2) end,
      'esperado_ate_ontem', case when x.situacao = 'em_curso' then round(x.esperado, 2) end,
      'diferenca_ritmo', case when x.situacao = 'em_curso' and x.esperado is not null then round(x.ate_ontem - x.esperado, 2) end,
      'media_diaria', case when x.situacao = 'em_curso' and x.dias_completos > 0 then round(x.ate_ontem / x.dias_completos, 2) end,
      'meta_diaria_necessaria', case when x.situacao = 'em_curso' and x.meta is not null
        then round(greatest(x.meta - x.ate_ontem, 0) / x.dias_restantes, 2) end,
      'aumento_necessario', case when x.situacao = 'em_curso' and x.meta is not null and x.dias_completos > 0 and x.ate_ontem > 0
        then round((greatest(x.meta - x.ate_ontem, 0) / x.dias_restantes) / (x.ate_ontem / x.dias_completos) - 1, 4) end,
      'perfil_semanal', coalesce(x.perfil_semanal, false),
      'fatores', (select jsonb_agg(jsonb_build_object('dia_semana', f.dow, 'fator', round(f.fator, 3)) order by f.dow) from fatores f),
      'ritmos', jsonb_build_object('sete', round(x.n7, 2), 'catorze', round(x.n14, 2), 'vinte_oito', round(x.n28, 2)),
      'projecao', case when x.situacao = 'em_curso' and x.nivel is not null then jsonb_build_object(
          'ritmo', round(x.ate_ontem + x.nivel * x.f_restante, 2),
          'conservador', round(x.ate_ontem + x.nivel_min * x.f_restante, 2),
          'otimista', round(x.ate_ontem + x.nivel_max * x.f_restante, 2)
        ) end,
      'ano_anterior', case when v_historico is not null and v_historico <= v_ano_ini then jsonb_build_object(
          'receita_mes', round(a.total, 2),
          'receita_ate_mesmo_dia', case when x.situacao = 'em_curso' then round(a.ate_dia, 2) end,
          'projecao_sazonal', case when x.situacao = 'em_curso' and x.dias_completos > 0 and a.ate_dia > 0 and a.total > 0
            then round(x.ate_ontem * a.total / a.ate_dia, 2) end,
          'crescimento', case
            when x.situacao = 'em_curso' and x.dias_completos > 0 and a.ate_dia > 0 then round(x.ate_ontem / a.ate_dia - 1, 4)
            when x.situacao = 'encerrado' and a.total > 0 then round(x.realizado / a.total - 1, 4) end
        ) end,
      'dias_sem_venda', (select count(*) from janela j where j.receita = 0)
    )
    from final x
    cross join ano a
  );
end;
$$;

comment on function public.get_meta_do_mes(uuid, date, date) is
  'Meta do mes e projecao de fechamento (D-395), da organizacao: realizado (receita bruta das vendas validas, daily_account_metrics), atingimento, ritmo contra a meta ponderado pelo perfil semanal, media diaria, meta diaria necessaria e a projecao em tres cenarios (ritmo de 28 dias; menor e maior ritmo entre 7, 14 e 28 dias), mais o mesmo mes do ano anterior quando o historico o cobre inteiro. Hoje entra na projecao pela media, nao pelo parcial. Eventos comerciais nao entram. security invoker: a RLS das contas decide a receita que a pessoa ve.';

revoke all on function public.get_meta_do_mes(uuid, date, date) from public, anon;
grant execute on function public.get_meta_do_mes(uuid, date, date) to authenticated, service_role;

-- ─── 5. Catalogo (METRICS 5J e 5K) ────────────────────────────

insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  ('atingimento_meta', 'Atingimento da meta do mês',
   'receita_bruta do mês até hoje ÷ monthly_goals.revenue_goal; faltam = max(meta − realizado, 0)',
   'monthly_goals + daily_account_metrics.gross_revenue', array['organization'],
   'Vendas válidas do mês (5.2), hoje incluído até a última atualização do resumo diário.',
   'Mês sem meta cadastrada: NULL, nunca 0%.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('esperado_meta', 'Esperado até ontem pela meta',
   'meta × Σ fator(dia da semana) dos dias completos ÷ Σ fator do mês; diferença de ritmo = realizado até ontem − esperado',
   'monthly_goals + perfil semanal de daily_account_metrics (8 semanas completas)', array['organization'],
   'Dias completos do mês (até ontem).', 'Hoje, em andamento. Perfil com menos de duas semanas de cada dia vira plano (fator 1).',
   'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('receita_media_diaria', 'Média diária do mês',
   'realizado até ontem ÷ dias completos do mês', 'daily_account_metrics.gross_revenue', array['organization'],
   'Dias completos do mês.', 'Hoje, em andamento. Dia 1 do mês: NULL.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('meta_diaria_necessaria', 'Meta diária necessária',
   'max(meta − realizado até ontem, 0) ÷ dias restantes (hoje incluído); aumento necessário = meta diária ÷ média diária − 1',
   'monthly_goals + daily_account_metrics', array['organization'],
   'Dias restantes do mês, hoje incluído.', 'Mês sem meta: NULL.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('projecao_fechamento_mes', 'Projeção de fechamento do mês',
   'realizado até ontem + ritmo × Σ fator dos dias restantes; ritmo = receita ÷ Σ fator nos últimos 28 dias completos; conservador e otimista = menor e maior ritmo entre 7, 14 e 28 dias',
   'daily_account_metrics.gross_revenue (8 semanas completas + o mês)', array['organization'],
   'Vendas válidas; perfil de dia da semana; tendência recente como faixa.',
   'Eventos comerciais (sem calendário). Hoje entra pela média, não pelo parcial. Sem 7 dias completos de histórico: NULL.',
   'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('projecao_sazonal_mes', 'Projeção pelo mesmo mês do ano anterior',
   'realizado até ontem × receita do mês inteiro do ano anterior ÷ receita do mesmo mês do ano anterior até o mesmo dia',
   'daily_account_metrics.gross_revenue', array['organization'],
   'Só quando o histórico cobre o mês inteiro do ano anterior.',
   'Crescimento do ano não entra na fatia: é conferência sazonal, não motor da projeção.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('imposto_estimado', 'Imposto estimado',
   'SUM(receita do pedido × alíquota vigente no dia de negócio do pedido)', 'orders + order_items + tax_rates',
   array['account', 'organization'], 'Vendas válidas com alíquota cadastrada para o dia.',
   'Qualquer pedido do conjunto sem alíquota torna o total NULL, nunca parcial.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('resultado_apos_imposto', 'Resultado após imposto',
   'resultado_venda − imposto dos mesmos pedidos cobertos', 'get_faturamento + tax_rates', array['account', 'organization'],
   'Pedidos cobertos (5F) com alíquota.', 'Ads, taxa fixa, parcelamento, Mercado Pago e custos fixos.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('margem_apos_imposto', 'Margem após imposto',
   'resultado_apos_imposto ÷ receita dos mesmos pedidos cobertos', 'get_faturamento + tax_rates', array['account', 'organization'],
   'Pedidos cobertos com alíquota.', 'Ads e custos fixos.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('resultado_contribuicao', 'Lucro após imposto e Ads',
   'resultado_apos_imposto − investimento_ads × (receita coberta ÷ receita bruta)', 'get_faturamento + get_ads_overview',
   array['account', 'organization'],
   'Pedidos cobertos; o Ads do período rateado pela participação da receita coberta.',
   'Custos fixos. Sem Ads completo no período ou sem alíquota: NULL.', 'excluded', 'America/Sao_Paulo', date '2026-09-23'),
  ('margem_contribuicao', 'Margem de contribuição',
   'resultado_contribuicao ÷ receita coberta = margem_apos_imposto − TACoS', 'get_faturamento + get_ads_overview',
   array['account', 'organization'],
   'Pedidos cobertos; imposto pela alíquota do dia; Ads rateado pela receita.',
   'Custos fixos (aluguel, folha, embalagem): é contribuição, não lucro líquido.', 'excluded', 'America/Sao_Paulo', date '2026-09-23');
