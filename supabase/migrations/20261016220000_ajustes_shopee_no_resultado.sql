-- ============================================================
-- D-485 -- os ajustes pos-escrow da Shopee descontados do resultado
--
-- A auditoria da primeira leitura real (16/10, docs/SHOPEE.md secao 8): a
-- Shopee libera o escrow_amount cheio e cobra o total_adjustment_amount
-- (negativo) A PARTE, fora do repasse -- em todos os pedidos sem devolucao
-- com ajuste, liberado = escrow_amount e a diferenca para o "depois do
-- ajuste" e exatamente o ajuste. O C-58 mostrava os ajustes so como
-- informativo; o resultado nao os descontava. Decisao do dono (delegada, 16/10):
-- o resultado e o dinheiro que fica com a empresa, entao desconta.
--
-- 1. C-58 (get_shopee_faturamento): resultado = recebido + ajustes - custo
--    (definitivo e provisorio tambem), e a coluna nova ajustes_cobertos, no FIM,
--    para a tela mostrar o degrau. recebido_coberto continua o escrow (o que o
--    repasse paga, C-64), e a cascata do C-61 nao muda.
-- 2. Por dia e por SKU: o mesmo resultado, para os dias somarem o TOTAL.
-- 3. O financeiro e relido UMA vez depois da liberacao do repasse
--    (shopee_orders_financials_pending): o pedido concluido so era relido se
--    mudasse na Shopee, e um ajuste lancado depois ficaria de fora.
-- O resto de cada funcao e o de producao, byte a byte. Drop + create so do
-- get_shopee_faturamento (coluna nova); os outros, create or replace.
-- ============================================================

drop function public.get_shopee_faturamento(uuid, date, date, uuid[]);

create function public.get_shopee_faturamento(
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
  ultima_atualizacao timestamptz,
  -- D-485: os ajustes pos-escrow dos cobertos (negativo = a Shopee cobrou), ja descontados do resultado.
  ajustes_cobertos numeric
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
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  classificado as (
    select k.* from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
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
      sum(k.recebido + coalesce(k.ajustes, 0) - k.custo) filter (where k.coberto) as resultado,
      count(k.order_sn) filter (where k.coberto and k.order_status = 'COMPLETED') as definitivos,
      sum(k.recebido + coalesce(k.ajustes, 0) - k.custo) filter (where k.coberto and k.order_status = 'COMPLETED') as resultado_definitivo,
      count(k.order_sn) filter (where k.coberto and k.order_status <> 'COMPLETED') as provisorios,
      sum(k.recebido + coalesce(k.ajustes, 0) - k.custo) filter (where k.coberto and k.order_status <> 'COMPLETED') as resultado_provisorio,
      count(k.order_sn) filter (where k.receita is not null and not k.financeiro_lido) as sem_financeiro,
      count(k.order_sn) filter (where k.sem_sku) as sem_sku,
      count(k.order_sn) filter (where not k.sem_sku and not k.custo_ok) as sem_custo,
      count(k.order_sn) filter (where k.coberto and k.custo_atual) as custo_atual,
      count(k.order_sn) filter (where k.coberto and k.aliquota is null) as sem_aliquota,
      sum(k.imposto) filter (where k.coberto) as imposto,
      sum(k.ajustes) filter (where k.coberto) as ajustes
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
    -- A receita bruta conhecida, como na linha da loja: loja lida sem pedido e 0.
    round(sum(coalesce(s.receita, 0)), 2),
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
    case when bool_or(s.atualizado is null) then null else min(s.atualizado) end,
    round(sum(s.ajustes), 2)
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
    pl.atualizado,
    case when pl.lida then round(pl.ajustes, 2) end
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_faturamento(uuid, date, date, uuid[]) is
  'Faturamento Shopee (D-437, D-443, D-485): por loja e o TOTAL (so lojas live ja lidas), resultado = recebido (escrow) + ajustes pos-escrow - custo e margem sobre a receita, nos pedidos cobertos; ajustes_cobertos mostra o degrau; definitivo (COMPLETED) e provisorio separados; imposto pela aliquota do dia (D-395) so com todas as aliquotas; o que nao cobre, contado por motivo. Le get_shopee_faturamento_pedidos. Nao soma com o resultado do ML (5F).';

revoke all on function public.get_shopee_faturamento(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_faturamento(uuid, date, date, uuid[]) to authenticated;

create or replace function public.get_shopee_faturamento_diario(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null
)
returns table (
  dia date,
  pedidos bigint,
  receita_bruta numeric,
  pedidos_sem_receita bigint,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  recebido_coberto numeric,
  custo_produtos numeric,
  resultado_venda numeric,
  margem_venda numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  return query
  select
    k.dia,
    count(*)::bigint,
    -- Dia so com pedidos de receita desconhecida: NULO (lacuna, nao zero).
    round(sum(k.receita), 2),
    count(*) filter (where k.receita is null)::bigint,
    count(*) filter (where k.coberto)::bigint,
    round(sum(k.receita) filter (where k.coberto), 2),
    round(sum(k.recebido) filter (where k.coberto), 2),
    round(sum(k.custo) filter (where k.coberto), 2),
    round(sum(k.recebido + coalesce(k.ajustes, 0) - k.custo) filter (where k.coberto), 2),
    round(sum(k.recebido + coalesce(k.ajustes, 0) - k.custo) filter (where k.coberto) / nullif(sum(k.receita) filter (where k.coberto), 0), 4)
  from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
  where k.environment = 'live' and k.loja_lida
  group by k.dia
  order by k.dia;
end;
$$;

create or replace function public.get_shopee_faturamento_por_sku(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] default null,
  -- 'receita' (maior receita bruta) | 'margem' (menor margem, so com cobertos)
  p_ordem text default 'receita',
  p_limit integer default 30
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  unidades bigint,
  pedidos bigint,
  receita_bruta numeric,
  pedidos_cobertos bigint,
  receita_coberta numeric,
  recebido_coberto numeric,
  custo_produtos numeric,
  resultado_venda numeric,
  margem_venda numeric,
  custo_atual boolean,
  -- SKUs da lista inteira, antes do limite.
  total_count bigint,
  pedidos_varios_skus bigint,
  receita_varios_skus numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
begin
  if coalesce(p_ordem, 'receita') not in ('receita', 'margem') then
    raise exception 'ordem invalida: % (use receita ou margem)', p_ordem;
  end if;

  return query
  with
  vendidos as (
    select k.* from public.get_shopee_faturamento_pedidos(p_organization_id, p_date_from, p_date_to, p_account_ids) k
    where k.environment = 'live' and k.loja_lida
  ),
  varios as (
    select count(*) as n, sum(p.receita) as receita
    from vendidos p
    where p.sku_unico is null and p.itens > 0 and not p.sem_sku
  ),
  por_sku as (
    select
      p.sku_unico as sku_id,
      sum(p.unidades)::bigint as unidades,
      count(*)::bigint as pedidos,
      sum(p.receita) as receita,
      count(*) filter (where p.coberto)::bigint as cobertos,
      sum(p.receita) filter (where p.coberto) as receita_coberta,
      sum(p.recebido) filter (where p.coberto) as recebido,
      sum(p.custo) filter (where p.coberto) as custo,
      sum(p.recebido + coalesce(p.ajustes, 0) - p.custo) filter (where p.coberto) as resultado,
      coalesce(bool_or(p.custo_atual) filter (where p.coberto), false) as custo_atual
    from vendidos p
    where p.sku_unico is not null
    group by p.sku_unico
  )
  select
    b.sku_id, s.sku, s.title,
    b.unidades, b.pedidos, round(b.receita, 2),
    b.cobertos, round(b.receita_coberta, 2), round(b.recebido, 2), round(b.custo, 2), round(b.resultado, 2),
    round(b.resultado / nullif(b.receita_coberta, 0), 4),
    b.custo_atual,
    count(*) over (),
    (select v.n from varios v),
    round((select v.receita from varios v), 2)
  from por_sku b
  join public.skus s on s.id = b.sku_id
  where coalesce(p_ordem, 'receita') = 'receita' or b.cobertos > 0
  order by
    case when coalesce(p_ordem, 'receita') = 'receita' then b.receita end desc nulls last,
    case when p_ordem = 'margem' then b.resultado / nullif(b.receita_coberta, 0) end asc nulls last,
    b.receita_coberta desc nulls last,
    b.sku_id
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

create or replace function public.shopee_orders_financials_pending(p_shopee_shop_id uuid, p_limit integer default 100)
returns table (order_sn text)
language sql
stable
set search_path = ''
as $$
  select o.order_sn
  from public.shopee_orders o
  -- D-485: a ultima liberacao de cada pedido da loja, agregada uma vez (uma
  -- busca por pedido custava 10x a fila de antes no ensaio de volume).
  left join (
    select e.order_sn, max(e.released_at) as liberado_em
    from public.shopee_escrow_releases e
    where e.shopee_shop_id = p_shopee_shop_id
    group by e.order_sn
  ) l on l.order_sn = o.order_sn
  where o.shopee_shop_id = p_shopee_shop_id
    and o.paid_at is not null
    and (
      (
        o.financials_error is null
        and (
          o.financials_synced_at is null
          or o.shopee_updated_at > o.financials_synced_at
          or (o.order_status not in ('COMPLETED', 'CANCELLED') and o.financials_synced_at < now() - interval '24 hours')
          -- D-485: uma releitura depois da liberacao do repasse, para o ajuste
          -- que a Shopee lancou ate la (total_adjustment_amount) entrar no resultado.
          or l.liberado_em > o.financials_synced_at
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

-- O espelho de docs/METRICS.md (5U): o resultado com os ajustes, e os ajustes com definicao propria.
update public.metric_definitions
   set formula = 'SUM(escrow_amount + total_adjustment_amount - custo dos produtos) dos pedidos cobertos',
       inclusions = 'Pedidos validos (5S) com receita conhecida, financeiro lido, SKU e custo em todos os itens. O recebido ja desconta comissao, taxas, frete da loja, cupons da loja e afiliados; os ajustes depois do repasse (shopee_ajustes_pos_repasse, D-485) entram porque a Shopee os cobra a parte. Devolvido tambem separado: COMPLETED (definitivo) e os demais (provisorio, o escrow ainda muda).',
       definition_updated_on = date '2026-10-16'
 where id = 'shopee_resultado_venda';

insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_ajustes_pos_repasse', 'Ajustes da Shopee depois do repasse',
   'SUM(total_adjustment_amount) dos pedidos cobertos (negativo = a Shopee cobrou da loja)',
   'get_shopee_faturamento (shopee_orders.total_adjustment_amount, do get_escrow_detail)', array['sku', 'account', 'organization'],
   'Os pedidos cobertos de shopee_resultado_venda. A Shopee repassa o escrow_amount cheio e cobra o ajuste a parte, fora do repasse (auditoria da leitura real, D-485); por isso ele entra no resultado. O financeiro e relido uma vez depois da liberacao do repasse, para o ajuste lancado ate la.',
   'Pedido sem ajuste: 0 no pedido; nenhum coberto = NULO. Ajuste lancado depois da releitura so entra se o pedido mudar na Shopee. Nao entra no recebido (o escrow) nem na composicao do recebido (C-61).',
   'excluded', 'America/Sao_Paulo', date '2026-10-16');
