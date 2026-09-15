-- ============================================================
-- D-356 -- `get_faturamento`: o dinheiro de um periodo, numa passada so.
--
-- O pedido do usuario: uma tela de faturamento "bem detalhada" com a margem
-- calculada assim --
--
--   recebido  = preco - comissao - frete do vendedor
--   resultado = recebido - custo do produto
--   margem    = resultado * 100 / preco (antes das taxas)
--
-- `recebido` e a `margem_operacional_pedido` de D-166 (o nome "receita
-- liquida" e vetado, METRICS 5C.1). O que entra agora e o CUSTO, que D-080
-- tinha deixado fora por falta de fonte: `sku_cost_history` existe desde D-149
-- e `skus.purchase_cost` esta preenchido em 3.068 de 3.240 SKUs (medido em
-- producao, 15/09/2026).
--
-- ------------------------------------------------------------
-- POR QUE UMA FUNCAO QUE DEVOLVE JSON, E NAO QUATRO QUE DEVOLVEM TABELA
--
-- A tela precisa de resumo, serie diaria, recorte por conta e por produto, e
-- as quatro partes saem da MESMA leitura de pedidos, itens, frete e custo.
-- Quatro RPCs varreriam os mesmos pedidos quatro vezes (D-306 mediu o custo
-- disso em /vendas). E a leitura nao pode morar numa funcao auxiliar em
-- `private`: `authenticated` nao tem USAGE nesse schema (medido), e uma
-- funcao `security invoker` que chama outra la dentro falharia para quem esta
-- logado.
--
-- `p_detalhe = false` devolve so o resumo -- e o que a tela usa para o
-- periodo anterior, sem pagar serie, contas e produtos de novo.
--
-- ------------------------------------------------------------
-- AS REGRAS, e cada uma tem motivo
--
-- 1. VENDA VALIDA e data de negocio sao as de METRICS 5.1: paid e
--    partially_refunded, dia civil de `date_created` em Sao Paulo.
-- 2. COMISSAO e `sale_fee * quantity`: a tarifa e por unidade (D-356).
-- 3. FRETE e do PEDIDO (`order_financials`). NULL e "nao observado" e NUNCA
--    vira zero (D-165): o pedido sem frete fica fora de tudo que o usa, e a
--    cobertura sai junto.
-- 3b. O DESCONTO DO VENDEDOR NAO E SUBTRAIDO: ja esta dentro do
--    `unit_price` (medido em D-356 -- a comissao e cobrada sobre o
--    `unit_price`, e ha desconto maior que o proprio preco, porque ele e
--    contado contra o preco de tabela). Sai como informacao.
-- 4. CUSTO NA DATA DA VENDA: o ultimo `new_cost` de `sku_cost_history` ate
--    `orders.date_created`; sem historico anterior a venda, o
--    `skus.purchase_cost` ATUAL -- e o pedido e contado em
--    `pedidos_custo_atual`, porque o custo e aproximado. Custo 0 ou nulo e
--    DESCONHECIDO (D-249/D-254/D-258): nunca somado como zero.
-- 5. KIT custa a soma dos componentes x quantidade (`sku_components`), cada
--    um com o custo na data; basta um componente sem custo para o kit ficar
--    sem custo. Kit sem componentes cadastrados usa o custo proprio.
-- 6. RESULTADO E MARGEM so sobre pedidos COBERTOS: frete observado, custo
--    conhecido e UMA linha de item. A ultima condicao e a de
--    METRICS 5E: um pedido tem um frete, e so da para atribui-lo ao produto
--    quando o pedido tem um produto. Medido: zero pedidos com mais de uma linha
--    em 340 mil -- verdade do dado, nao garantia; os que aparecerem saem da
--    margem e sao contados em `pedidos_multi_item`.
-- 7. Numerador e denominador da margem vem do MESMO subconjunto (D-166).
-- 8. Nada aqui e lucro liquido: impostos, taxa fixa, parcelamento, custo do
--    Mercado Pago, reembolsos posteriores e Ads ficam fora, e a tela diz.
-- ============================================================

create or replace function public.get_faturamento(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_detalhe boolean default true
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
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
      p.ml_account_id,
      (p.date_created at time zone 'America/Sao_Paulo')::date as dia,
      case when p.pack_id is null then 'order:' || p.id::text else 'pack:' || p.pack_id::text end as compra,
      oi.sku_id,
      oi.quantity,
      oi.quantity * oi.unit_price as receita,
      oi.sale_fee * oi.quantity as comissao,
      count(*) over (partition by p.id) as itens_no_pedido,
      -- Frete e desconto sao do PEDIDO: vao so na primeira linha, para nao
      -- serem somados uma vez por item.
      case when row_number() over (partition by p.id order by oi.position) = 1 then f.seller_shipping_cost end as frete,
      case when row_number() over (partition by p.id order by oi.position) = 1 then f.seller_discount end as desconto,
      c.custo_unitario * oi.quantity as custo,
      c.fonte as custo_fonte
    from pedidos p
    join public.order_items oi
      on oi.order_id = p.id
     and oi.organization_id = p.organization_id
     and oi.ml_account_id = p.ml_account_id
    left join public.order_financials f on f.order_id = p.id
    left join lateral (
      select
        case
          when s.kind = 'KIT' and k.componentes > 0 then k.custo
          else nullif(coalesce(hs.new_cost, s.purchase_cost), 0)
        end as custo_unitario,
        case
          when s.kind = 'KIT' and k.componentes > 0 then k.fonte
          when coalesce(hs.new_cost, 0) > 0 then 'historico'
          when coalesce(s.purchase_cost, 0) > 0 then 'atual'
        end as fonte
      from public.skus s
      left join lateral (
        select h.new_cost
        from public.sku_cost_history h
        where h.sku_id = s.id
          and h.changed_at <= p.date_created
        order by h.changed_at desc
        limit 1
      ) hs on true
      left join lateral (
        select
          count(*) as componentes,
          case when count(*) > 0 and bool_and(cc.custo_unitario is not null)
               then sum(cc.custo_unitario * sc.quantity) end as custo,
          case when bool_and(cc.fonte = 'historico') then 'historico' else 'atual' end as fonte
        from public.sku_components sc
        cross join lateral (
          select
            nullif(coalesce(hc.new_cost, cs.purchase_cost), 0) as custo_unitario,
            case
              when coalesce(hc.new_cost, 0) > 0 then 'historico'
              when coalesce(cs.purchase_cost, 0) > 0 then 'atual'
            end as fonte
          from public.skus cs
          left join lateral (
            select h.new_cost
            from public.sku_cost_history h
            where h.sku_id = cs.id
              and h.changed_at <= p.date_created
            order by h.changed_at desc
            limit 1
          ) hc on true
          where cs.id = sc.component_sku_id
        ) cc
        where sc.kit_sku_id = s.id
      ) k on true
      where s.id = oi.sku_id
    ) c on oi.sku_id is not null
  ),
  pedido as materialized (
    select
      l.order_id,
      l.ml_account_id,
      l.dia,
      l.compra,
      sum(l.receita) as receita,
      sum(l.quantity) as unidades,
      sum(l.comissao) as comissao,
      bool_and(l.comissao is not null) as comissao_ok,
      max(l.frete) as frete,
      max(l.desconto) as desconto,
      max(l.itens_no_pedido) as itens,
      sum(l.custo) as custo,
      bool_and(l.custo is not null) as custo_ok,
      bool_or(l.custo_fonte = 'atual') as custo_atual,
      bool_or(l.sku_id is null) as sem_sku
    from linhas l
    group by l.order_id, l.ml_account_id, l.dia, l.compra
  ),
  classificado as materialized (
    select
      p.*,
      (p.frete is not null and p.comissao_ok) as com_custos,
      (p.frete is not null and p.comissao_ok and p.custo_ok and p.itens = 1) as coberto
    from pedido p
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
      'pedidos_multi_item', count(*) filter (where k.itens > 1)
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
    select coalesce(jsonb_agg(to_jsonb(c) order by c.receita_bruta desc), '[]'::jsonb) as j
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
        select coalesce(jsonb_agg(to_jsonb(x) order by x.receita_bruta desc), '[]'::jsonb)
        from (
          select b.*, s.sku, s.title
          from por_sku_base b
          join public.skus s on s.id = b.sku_id
          order by b.receita_bruta desc
          limit 30
        ) x
      ),
      'menor_margem', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.margem_venda, x.receita_coberta desc), '[]'::jsonb)
        from (
          select b.*, s.sku, s.title
          from por_sku_base b
          join public.skus s on s.id = b.sku_id
          where b.pedidos_cobertos > 0
            and b.margem_venda < 0.10
          order by b.margem_venda, b.receita_coberta desc
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
$$;

comment on function public.get_faturamento(date, date, uuid, boolean) is
  'Faturamento de um periodo (D-356): receita, comissao (sale_fee * quantity), frete do vendedor (o desconto e informativo: ja esta no preco), custo do produto na data da venda (kit = soma dos componentes) e margem, numa passada so. Resultado e margem SO sobre pedidos cobertos (frete observado, custo conhecido, uma linha de item), com a cobertura devolvida junto; o que nao e observado volta NULL, nunca zero. Nao e lucro liquido: impostos, taxa fixa, parcelamento, custo do Mercado Pago, reembolsos e Ads ficam fora. p_detalhe = false devolve so o resumo. security invoker.';

revoke all on function public.get_faturamento(date, date, uuid, boolean) from public, anon;
grant execute on function public.get_faturamento(date, date, uuid, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- O catalogo antes da tela (METRICS.md regra central e secao 6).
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('custo_produtos_vendidos',
   'Custo dos produtos vendidos',
   'SUM(order_items.quantity × custo unitário do SKU na data do pedido); KIT = Σ custo dos componentes × quantidade',
   'sku_cost_history (último new_cost até orders.date_created) ou skus.purchase_cost atual quando não há histórico anterior à venda; sku_components para kits',
   array['sku', 'account', 'organization'],
   'Pedidos cobertos: item com SKU vinculado e custo conhecido (> 0); kit com todos os componentes com custo.',
   'Itens sem SKU, SKU com custo nulo ou 0 e kit com componente sem custo — nunca somados como zero (D-249). Custo atual usado por falta de histórico é contado à parte (pedidos_custo_atual).',
   'excluded', 'America/Sao_Paulo', date '2026-09-15'),
  ('resultado_venda',
   'Resultado da venda',
   'margem_operacional_pedido − custo_produtos_vendidos, sobre pedidos COBERTOS',
   'orders + order_items (sale_fee × quantity) + order_financials (D-165) + custo_produtos_vendidos',
   array['sku', 'account', 'organization'],
   'Pedidos válidos com frete observado, custo conhecido e uma linha de item; receita, comissão, frete e custo do mesmo subconjunto. O desconto do vendedor não é subtraído: já está no preço (D-356).',
   'NÃO é lucro líquido: impostos, taxa fixa por pedido, parcelamento, custo de cobrança do Mercado Pago, reembolsos posteriores e Ads ficam fora.',
   'excluded', 'America/Sao_Paulo', date '2026-09-15'),
  ('margem_venda',
   'Margem sobre a venda',
   'resultado_venda / NULLIF(receita_bruta do MESMO subconjunto coberto, 0)',
   'Componentes canônicos acima; fração, a tela formata em percentual',
   array['sku', 'account', 'organization'],
   'Mesmo subconjunto coberto de resultado_venda; cobertura declarada ao lado.',
   'Pedidos sem frete ou sem custo observados, e pedidos com mais de uma linha de item; zero cobertura = NULL, nunca 0%.',
   'excluded', 'America/Sao_Paulo', date '2026-09-15'),
  ('frete_medio_pedido',
   'Frete médio por pedido',
   'frete_vendedor / NULLIF(pedidos com frete observado, 0)',
   'order_financials.seller_shipping_cost (D-165)',
   array['account', 'organization'],
   'Pedidos válidos com o custo OBSERVADO.',
   'Pedido sem observação fica fora do numerador E do denominador.',
   'excluded', 'America/Sao_Paulo', date '2026-09-15'),
  ('comissao_percentual',
   'Comissão sobre a receita',
   'taxas_ml / NULLIF(receita_bruta, 0)',
   'order_items.sale_fee × quantity e orders.total_amount',
   array['sku', 'account', 'organization'],
   'Vendas válidas do período.',
   'Taxa fixa, parcelamento e impostos, que taxas_ml não contém (5C.2).',
   'excluded', 'America/Sao_Paulo', date '2026-09-15')
on conflict (id) do update
  set name = excluded.name,
      formula = excluded.formula,
      source = excluded.source,
      granularities = excluded.granularities,
      inclusions = excluded.inclusions,
      exclusions = excluded.exclusions,
      cancellation_treatment = excluded.cancellation_treatment,
      timezone = excluded.timezone,
      definition_updated_on = excluded.definition_updated_on;
