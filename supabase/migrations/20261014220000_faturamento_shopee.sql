-- ============================================================
-- D-437 -- o faturamento da Shopee: quanto sobra de cada venda, pela propria
-- Shopee (etapa E5 da frente multicanal; a parte Shopee de /faturamento).
--
-- A conta: resultado = RECEBIDO - CUSTO dos produtos; margem = resultado /
-- receita bruta, sobre os pedidos COBERTOS. O recebido e o `escrow_amount`
-- (D-427): a Shopee ja desconta comissao, taxa de servico, taxa de
-- transacao, o frete que fica com a loja, cupons da loja e afiliados. Por
-- isso a conta e mais curta que a do ML (5F: preco - comissao - frete -
-- custo) e os dois resultados NAO se somam -- o "recebido" do ML deixa de
-- fora taxa fixa, parcelamento e Mercado Pago. Nunca "lucro liquido".
--
-- COBERTO = pedido valido (5S) com receita conhecida, financeiro lido, SKU em
-- todos os itens e custo conhecido de todos. O resto e contado a parte, por
-- motivo -- nunca vira zero.
--
-- PROVISORIO x DEFINITIVO: o escrow muda ate o pedido completar. Em vez de
-- escolher por quem le, a RPC devolve as tres somas: o resultado de todos os
-- cobertos e, separados, o dos COMPLETED (definitivo) e o dos demais
-- (provisorio). Qual mostrar e decisao de tela/dono, sem outra migration.
--
-- O CUSTO E A REGRA DE D-356, ESCRITA DENTRO, COMO EM `get_faturamento`: o
-- ultimo `new_cost` ate a data do pedido (empate: maior id), senao o custo
-- atual; 0 ou nulo e DESCONHECIDO; KIT e a soma dos componentes, e so existe
-- se todos tem custo. Dentro e nao num helper: uma RPC `security invoker`
-- nao alcanca o schema `private`, e abrir o schema ou trocar para `security
-- definer` custaria mais do que a repeticao. Um teste de EQUIVALENCIA
-- compara com `get_faturamento` para os mesmos SKUs na mesma data. O ML nao
-- muda.
--
-- IMPOSTO (D-395): receita bruta x aliquota vigente no dia; so existe quando
-- TODOS os pedidos cobertos do conjunto tem aliquota.
--
-- Loja de sandbox e loja nunca lida: so na linha da loja, nunca no TOTAL.
-- security invoker: a permissao por loja (D-433) vale.
-- ============================================================

create or replace function public.get_shopee_faturamento(
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
  pedidos bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  recebido_coberto numeric,
  custo_produtos numeric,
  resultado_venda numeric,
  margem_venda numeric,
  pedidos_definitivos bigint,
  resultado_definitivo numeric,
  pedidos_provisorios bigint,
  resultado_provisorio numeric,
  pedidos_sem_financeiro bigint,
  pedidos_sem_sku bigint,
  pedidos_sem_custo bigint,
  pedidos_custo_atual bigint,
  pedidos_sem_aliquota bigint,
  imposto_coberto numeric,
  resultado_apos_imposto numeric,
  margem_apos_imposto numeric,
  ultima_atualizacao timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  vendas as (
    select v.shopee_shop_id, v.order_sn, v.order_status, v.dia, v.shopee_created_at,
           v.receita_bruta as receita, v.recebido, v.financeiro_lido
    from public.shopee_sales_orders v
    where v.organization_id = p_organization_id
      and v.shopee_shop_id in (select l.id from lojas l)
      and v.situacao = 'VALIDA'
      and v.shopee_created_at >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and v.shopee_created_at < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  custo_itens as (
    -- A regra de custo de get_faturamento (D-356), item a item: o custo do
    -- SKU na data (historico, senao atual; 0 e desconhecido) e, no KIT, a
    -- soma dos componentes -- so com todos conhecidos.
    select
      i.shopee_shop_id,
      i.order_sn,
      i.sku_id,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.custo
        else nullif(coalesce(hs.new_cost, s.purchase_cost), 0)
      end * i.quantity as custo,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.fonte
        when coalesce(hs.new_cost, 0) > 0 then 'historico'
        when coalesce(s.purchase_cost, 0) > 0 then 'atual'
      end as fonte
    from vendas v
    join public.shopee_order_items i
      on i.shopee_shop_id = v.shopee_shop_id and i.order_sn = v.order_sn
    left join public.skus s on s.id = i.sku_id
    left join lateral (
      select x.new_cost
      from public.sku_cost_history x
      where x.sku_id = s.id and x.changed_at <= v.shopee_created_at
      order by x.changed_at desc, x.id desc
      limit 1
    ) hs on true
    left join lateral (
      select
        count(*) as componentes,
        case when count(*) > 0 and bool_and(cu.custo is not null) then sum(cu.custo * c.quantity) end as custo,
        case when bool_and(cu.fonte = 'historico') then 'historico' else 'atual' end as fonte
      from public.sku_components c
      join public.skus cs on cs.id = c.component_sku_id
      left join lateral (
        select x.new_cost
        from public.sku_cost_history x
        where x.sku_id = cs.id and x.changed_at <= v.shopee_created_at
        order by x.changed_at desc, x.id desc
        limit 1
      ) hc on true
      cross join lateral (
        select
          nullif(coalesce(hc.new_cost, cs.purchase_cost), 0) as custo,
          case
            when coalesce(hc.new_cost, 0) > 0 then 'historico'
            when coalesce(cs.purchase_cost, 0) > 0 then 'atual'
          end as fonte
      ) cu
      where c.kit_sku_id = s.id
    ) k on true
  ),
  por_pedido as (
    select
      v.shopee_shop_id,
      v.order_sn,
      v.dia,
      v.order_status,
      v.receita,
      v.recebido,
      v.financeiro_lido,
      count(ci.order_sn) as itens,
      coalesce(bool_or(ci.sku_id is null), false) as sem_sku,
      sum(ci.custo) as custo,
      coalesce(bool_and(ci.custo is not null), false) as custo_ok,
      coalesce(bool_or(ci.fonte = 'atual'), false) as custo_atual
    from vendas v
    left join custo_itens ci on ci.shopee_shop_id = v.shopee_shop_id and ci.order_sn = v.order_sn
    group by v.shopee_shop_id, v.order_sn, v.dia, v.order_status, v.receita, v.recebido, v.financeiro_lido
  ),
  aliquotas as (
    select t.valid_from as desde,
           lead(t.valid_from) over (order by t.valid_from) as ate,
           t.rate
    from public.tax_rates t
    where t.organization_id = p_organization_id
  ),
  classificado as (
    select
      p.*,
      a.rate as aliquota,
      p.receita * a.rate as imposto,
      (p.receita is not null and p.financeiro_lido and p.recebido is not null
        and p.itens > 0 and not p.sem_sku and p.custo_ok) as coberto
    from por_pedido p
    left join aliquotas a on p.dia >= a.desde and (a.ate is null or p.dia < a.ate)
  ),
  por_loja as (
    select
      l.id,
      l.nome,
      l.environment,
      l.orders_last_success_at as atualizado,
      l.orders_last_success_at is not null as lida,
      count(k.order_sn) as pedidos,
      sum(k.receita) as receita,
      count(k.order_sn) filter (where k.receita is null) as sem_receita,
      count(k.order_sn) filter (where k.coberto) as cobertos,
      sum(k.receita) filter (where k.coberto) as receita_coberta,
      sum(k.recebido) filter (where k.coberto) as recebido_coberto,
      sum(k.custo) filter (where k.coberto) as custo,
      sum(k.recebido - k.custo) filter (where k.coberto) as resultado,
      count(k.order_sn) filter (where k.coberto and k.order_status = 'COMPLETED') as definitivos,
      sum(k.recebido - k.custo) filter (where k.coberto and k.order_status = 'COMPLETED') as resultado_definitivo,
      count(k.order_sn) filter (where k.coberto and k.order_status <> 'COMPLETED') as provisorios,
      sum(k.recebido - k.custo) filter (where k.coberto and k.order_status <> 'COMPLETED') as resultado_provisorio,
      count(k.order_sn) filter (where k.receita is not null and not k.financeiro_lido) as sem_financeiro,
      count(k.order_sn) filter (where k.sem_sku) as sem_sku,
      count(k.order_sn) filter (where not k.sem_sku and not k.custo_ok) as sem_custo,
      count(k.order_sn) filter (where k.coberto and k.custo_atual) as custo_atual,
      count(k.order_sn) filter (where k.coberto and k.aliquota is null) as sem_aliquota,
      sum(k.imposto) filter (where k.coberto) as imposto
    from lojas l
    left join classificado k on k.shopee_shop_id = l.id
    group by l.id, l.nome, l.environment, l.orders_last_success_at
  ),
  -- O que entra no TOTAL: loja live ja lida.
  somaveis as (
    select pl.* from por_loja pl where pl.environment = 'live' and pl.lida
  )
  select
    'TOTAL'::text, null::uuid, null::text, null::text,
    sum(s.pedidos)::bigint,
    round(sum(s.receita), 2),
    sum(s.sem_receita)::bigint,
    sum(s.cobertos)::bigint,
    round(sum(s.receita_coberta), 2),
    round(sum(s.recebido_coberto), 2),
    round(sum(s.custo), 2),
    round(sum(s.resultado), 2),
    round(sum(s.resultado) / nullif(sum(s.receita_coberta), 0), 4),
    sum(s.definitivos)::bigint,
    round(sum(s.resultado_definitivo), 2),
    sum(s.provisorios)::bigint,
    round(sum(s.resultado_provisorio), 2),
    sum(s.sem_financeiro)::bigint,
    sum(s.sem_sku)::bigint,
    sum(s.sem_custo)::bigint,
    sum(s.custo_atual)::bigint,
    sum(s.sem_aliquota)::bigint,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0 then round(sum(s.imposto), 2) end,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0 then round(sum(s.resultado) - sum(s.imposto), 2) end,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0
         then round((sum(s.resultado) - sum(s.imposto)) / nullif(sum(s.receita_coberta), 0), 4) end,
    case when bool_or(s.atualizado is null) then null else min(s.atualizado) end
  from somaveis s
  having count(*) > 0

  union all

  -- Por loja. Loja nunca lida: tudo NULO.
  select
    'CONTA', pl.id, pl.nome, pl.environment,
    case when pl.lida then pl.pedidos end::bigint,
    case when pl.lida then round(coalesce(pl.receita, 0), 2) end,
    case when pl.lida then pl.sem_receita end::bigint,
    case when pl.lida then pl.cobertos end::bigint,
    case when pl.lida then round(pl.receita_coberta, 2) end,
    case when pl.lida then round(pl.recebido_coberto, 2) end,
    case when pl.lida then round(pl.custo, 2) end,
    case when pl.lida then round(pl.resultado, 2) end,
    case when pl.lida then round(pl.resultado / nullif(pl.receita_coberta, 0), 4) end,
    case when pl.lida then pl.definitivos end::bigint,
    case when pl.lida then round(pl.resultado_definitivo, 2) end,
    case when pl.lida then pl.provisorios end::bigint,
    case when pl.lida then round(pl.resultado_provisorio, 2) end,
    case when pl.lida then pl.sem_financeiro end::bigint,
    case when pl.lida then pl.sem_sku end::bigint,
    case when pl.lida then pl.sem_custo end::bigint,
    case when pl.lida then pl.custo_atual end::bigint,
    case when pl.lida then pl.sem_aliquota end::bigint,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0 then round(pl.imposto, 2) end,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0 then round(pl.resultado - pl.imposto, 2) end,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0
         then round((pl.resultado - pl.imposto) / nullif(pl.receita_coberta, 0), 4) end,
    pl.atualizado
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_faturamento(uuid, date, date, uuid[]) is
  'Faturamento Shopee (D-437): por loja e o TOTAL (so lojas live ja lidas), resultado = recebido (escrow) - custo e margem sobre a receita, nos pedidos cobertos; definitivo (COMPLETED) e provisorio separados; imposto pela aliquota do dia (D-395) so com todas as aliquotas; o que nao cobre, contado por motivo. Nao soma com o resultado do ML (5F).';

revoke all on function public.get_shopee_faturamento(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_faturamento(uuid, date, date, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- O espelho de docs/METRICS.md (secao 5U).
-- ------------------------------------------------------------
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_custo_produtos', 'Custo dos produtos vendidos na Shopee',
   'SUM(quantity x custo unitario na data do pedido) dos itens dos pedidos cobertos; KIT = soma dos componentes',
   'get_shopee_faturamento (shopee_order_items.sku_id, sku_cost_history, skus.purchase_cost, sku_components)', array['account', 'organization'],
   'A regra de custo_produtos_vendidos (5F, D-356): ultimo new_cost ate a criacao do pedido, senao o custo atual (contado em pedidos_custo_atual).',
   'Custo 0 ou nulo e desconhecido: o pedido sai da cobertura e e contado em pedidos_sem_custo. Item sem SKU: pedidos_sem_sku.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_resultado_venda', 'Resultado da venda na Shopee',
   'SUM(escrow_amount - custo dos produtos) dos pedidos cobertos',
   'get_shopee_faturamento (shopee_orders.escrow_amount, shopee_custo_produtos)', array['account', 'organization'],
   'Pedidos validos (5S) com receita conhecida, financeiro lido, SKU e custo em todos os itens. O recebido ja desconta comissao, taxas, frete da loja, cupons da loja e afiliados. Devolvido tambem separado: COMPLETED (definitivo) e os demais (provisorio, o escrow ainda muda).',
   'Nao e lucro liquido: imposto (a parte, D-395), Ads e despesas fixas ficam fora. Nao soma com resultado_venda do ML (5F), que deixa de fora taxa fixa, parcelamento e Mercado Pago.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_margem_venda', 'Margem sobre a venda na Shopee',
   'shopee_resultado_venda / receita bruta dos MESMOS pedidos cobertos',
   'get_shopee_faturamento', array['account', 'organization'],
   'Fracao; formatada em %. Cobertura ao lado.',
   'Zero cobertura = NULO, nunca 0%.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_imposto_estimado', 'Imposto estimado sobre a venda na Shopee',
   'SUM(receita bruta x aliquota vigente no dia) dos pedidos cobertos',
   'get_shopee_faturamento (tax_rates)', array['account', 'organization'],
   'A aliquota da organizacao vigente no dia do pedido (D-395).',
   'Se algum pedido coberto nao tem aliquota no dia, o total e NULO (somar so os que tem daria um imposto menor com cara de exato).',
   'excluded', 'America/Sao_Paulo', date '2026-10-14'),
  ('shopee_resultado_apos_imposto', 'Resultado da venda na Shopee apos imposto',
   'shopee_resultado_venda - shopee_imposto_estimado',
   'get_shopee_faturamento', array['account', 'organization'],
   'Os mesmos pedidos cobertos.',
   'NULO quando o imposto e NULO. Nao e lucro liquido.',
   'excluded', 'America/Sao_Paulo', date '2026-10-14');
