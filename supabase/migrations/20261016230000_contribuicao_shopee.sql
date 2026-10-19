-- ============================================================
-- D-487 -- o Ads CPC da loja na margem de contribuicao da Shopee (C-58)
--
-- O ML tem o lucro apos imposto e Ads (METRICS 5K, D-395); a Shopee parava no
-- resultado apos imposto. Mesma regra, calculada no SQL (o navegador nao faz
-- conta):
--   resultado_contribuicao = resultado_apos_imposto - Ads x (receita coberta / receita bruta)
--   margem_contribuicao    = resultado_contribuicao / receita coberta
-- - O Ads e o CPC da loja (daily_shopee_ads_metrics, a fonte do C-63); o GMV
--   Max fica fora, como no C-63.
-- - Entra so com a leitura de Ads cobrindo o periodo inteiro (a regra do C-63)
--   e com o gasto de todos os dias lidos; senao NULO. Leitura cobrindo e nenhum
--   anuncio: 0, que e fato.
-- - Rateado pela participacao da receita coberta: na loja, pela cobertura da
--   loja; no TOTAL, o Ads de todas as lojas pela cobertura do TOTAL (como o
--   5K, que rateia o Ads da organizacao). Com 100% de cobertura, os dois somem.
-- - Sem aliquota (imposto NULO): a contribuicao tambem e NULA.
-- Colunas novas no FIM (drop + create); o resto e o da D-485, byte a byte.
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
  ajustes_cobertos numeric,
  -- D-487: o Ads CPC da loja no periodo (so com a leitura de Ads cobrindo o periodo
  -- inteiro), a parte dele rateada pela receita coberta e o lucro apos imposto e Ads.
  investimento_ads numeric,
  ads_rateado numeric,
  resultado_contribuicao numeric,
  margem_contribuicao numeric
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
#variable_conflict use_column
declare
  v_ate date := least(p_date_to, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'periodo invalido: % a %', p_date_from, p_date_to;
  end if;

  return query
  with
  lojas as (
    select s.id, coalesce(s.shop_name, 'Loja Shopee ' || s.shop_id::text) as nome, s.environment, s.orders_last_success_at,
           -- D-487: a leitura de Ads cobre o periodo inteiro (a regra do C-63).
           (s.ads_read_from is not null and p_date_from >= s.ads_read_from and v_ate <= s.ads_read_until) as ads_coberta
    from public.shopee_shops s
    where s.organization_id = p_organization_id
      and (p_account_ids is null or s.id = any (p_account_ids))
  ),
  -- D-487: o Ads CPC da loja no periodo (daily_shopee_ads_metrics, a fonte do C-63).
  ads as (
    select d.shopee_shop_id, sum(d.expense) as investimento, count(*) filter (where d.expense is null) as dias_sem_gasto
    from public.daily_shopee_ads_metrics d
    where d.organization_id = p_organization_id
      and d.shopee_shop_id in (select l.id from lojas l)
      and d.metric_date between p_date_from and p_date_to
    group by d.shopee_shop_id
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
      sum(k.ajustes) filter (where k.coberto) as ajustes,
      -- D-487: sem a leitura cobrindo o periodo, ou com dia lido sem o gasto: NULO.
      -- Leitura cobrindo e nenhum anuncio: 0, que e fato.
      case when l.ads_coberta and coalesce(a.dias_sem_gasto, 0) = 0 then coalesce(a.investimento, 0) end as investimento_ads
    from lojas l
    left join ads a on a.shopee_shop_id = l.id
    left join classificado k on k.shopee_shop_id = l.id
    group by l.id, l.nome, l.environment, l.orders_last_success_at, l.ads_coberta, a.investimento, a.dias_sem_gasto
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
    round(sum(s.ajustes), 2),
    case when bool_and(s.investimento_ads is not null) then round(sum(s.investimento_ads), 2) end,
    case when bool_and(s.investimento_ads is not null) then round((sum(s.investimento_ads) * coalesce(sum(s.receita_coberta), 0) / nullif(sum(coalesce(s.receita, 0)), 0)), 2) end,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0 and bool_and(s.investimento_ads is not null)
         then round(sum(s.resultado) - sum(s.imposto) - (sum(s.investimento_ads) * coalesce(sum(s.receita_coberta), 0) / nullif(sum(coalesce(s.receita, 0)), 0)), 2) end,
    case when sum(s.cobertos) > 0 and sum(s.sem_aliquota) = 0 and bool_and(s.investimento_ads is not null)
         then round((sum(s.resultado) - sum(s.imposto) - (sum(s.investimento_ads) * coalesce(sum(s.receita_coberta), 0) / nullif(sum(coalesce(s.receita, 0)), 0))) / nullif(sum(s.receita_coberta), 0), 4) end
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
    case when pl.lida then round(pl.ajustes, 2) end,
    case when pl.lida then round(pl.investimento_ads, 2) end,
    case when pl.lida then round((pl.investimento_ads * coalesce(pl.receita_coberta, 0) / nullif(coalesce(pl.receita, 0), 0)), 2) end,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0 and pl.investimento_ads is not null
         then round(pl.resultado - pl.imposto - (pl.investimento_ads * coalesce(pl.receita_coberta, 0) / nullif(coalesce(pl.receita, 0), 0)), 2) end,
    case when pl.lida and pl.cobertos > 0 and pl.sem_aliquota = 0 and pl.investimento_ads is not null
         then round((pl.resultado - pl.imposto - (pl.investimento_ads * coalesce(pl.receita_coberta, 0) / nullif(coalesce(pl.receita, 0), 0))) / nullif(pl.receita_coberta, 0), 4) end
  from por_loja pl;
end;
$$;

comment on function public.get_shopee_faturamento(uuid, date, date, uuid[]) is
  'Faturamento Shopee (D-437, D-443, D-485, D-487): por loja e o TOTAL (so lojas live ja lidas), resultado = recebido (escrow) + ajustes pos-escrow - custo e margem sobre a receita, nos pedidos cobertos; ajustes_cobertos mostra o degrau; definitivo (COMPLETED) e provisorio separados; imposto pela aliquota do dia (D-395) so com todas as aliquotas; o lucro apos imposto e o Ads CPC da loja rateado pela receita coberta (5K), so com a leitura de Ads cobrindo o periodo; o que nao cobre, contado por motivo. Le get_shopee_faturamento_pedidos. Nao soma com o resultado do ML (5F).';

revoke all on function public.get_shopee_faturamento(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.get_shopee_faturamento(uuid, date, date, uuid[]) to authenticated;

-- O espelho de docs/METRICS.md (5U).
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions, cancellation_treatment, timezone, definition_updated_on)
values
  ('shopee_resultado_contribuicao', 'Lucro apos imposto e Ads (Shopee)',
   'shopee_resultado_apos_imposto - shopee_investimento_ads x (receita coberta / receita bruta)',
   'get_shopee_faturamento (C-58), Ads de daily_shopee_ads_metrics (C-63)', array['account', 'organization'],
   'Os mesmos pedidos cobertos de shopee_resultado_venda. O Ads CPC da loja entra rateado pela participacao da receita coberta (premissa declarada, como o 5K do ML; some com cobertura de 100%): na loja, pela cobertura dela; no TOTAL, o Ads das lojas pela cobertura do TOTAL.',
   'Leitura de Ads sem cobrir o periodo inteiro, ou dia lido sem o gasto: NULO (leitura cobrindo e nenhum anuncio: 0). Imposto NULO (sem aliquota): NULO. O GMV Max fica fora, como no C-63. Custos fixos ficam fora: e contribuicao, nao lucro liquido.',
   'excluded', 'America/Sao_Paulo', date '2026-10-16'),
  ('shopee_margem_contribuicao', 'Margem de contribuicao (Shopee)',
   'shopee_resultado_contribuicao / receita coberta',
   'get_shopee_faturamento (C-58)', array['account', 'organization'],
   'Fracao; formatada em %. Os mesmos pedidos cobertos.',
   'NULO quando shopee_resultado_contribuicao e NULO ou nao ha cobertos. E contribuicao, nao lucro liquido.',
   'excluded', 'America/Sao_Paulo', date '2026-10-16');
