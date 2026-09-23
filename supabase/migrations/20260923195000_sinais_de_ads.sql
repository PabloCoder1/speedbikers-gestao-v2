-- D-398 — Sinais de Ads por campanha, e o dia de Ads que o Mercado Livre ainda
-- não consolidou (trilha 5J).
--
-- O QUE FOI MEDIDO ANTES (produção, 23/09/2026, sync das 11h):
--   * 65 campanhas nas 4 contas, 37 ativas, TODAS com `roas_target`,
--     `acos_target` e `budget`; estratégia PROFITABILITY em todas; 97 dias de
--     métrica. O `budget` é DIÁRIO: o gasto do dia bate exatamente nele
--     (280,00; 100,00; 150,00) em vários dias;
--   * 21/09 e 22/09 vieram com gasto e cliques em TODAS as campanhas, mas com
--     venda ZERO -- e 22/09 também com impressão zero --, enquanto 23/09 (hoje,
--     parcial) já tinha venda. Nenhum dia mais antigo tem esse padrão: o
--     Mercado Livre publica gasto e clique antes da venda atribuída, e a
--     regravação dos 90 dias (D-363) corrige depois. Sem regra, "ontem" teria
--     ROAS zero e todo período até ontem, ROAS subestimado;
--   * semana de 14 a 20/09: 51 campanhas com gasto, nenhuma sem venda,
--     nenhuma com ROAS < 1, 7 com ROAS abaixo de 80% da meta, 25 abaixo da
--     meta por qualquer margem (a oscilação normal em torno do alvo -- não é
--     sinal), 3 com CPC subindo e conversão caindo, 6 com gasto subindo e ROAS
--     caindo, 6 no teto do orçamento acima da meta.
--
-- 1. DIA PENDENTE: um dia antes de hoje, com gasto, depois do último dia que
--    teve venda atribuída E impressão (somando as contas do recorte). Hoje é
--    sempre "em andamento" e não entra na lista. `get_ads_overview` passa a
--    devolver `dias_pendentes`; a tela não julga ROAS, ACOS nem vendas com Ads
--    com esses dias. O INVESTIMENTO deles é conhecido e continua valendo.
--
-- 2. `get_sinais_ads`: os 7 dias consolidados até o último dia consolidado,
--    contra os 7 anteriores, por campanha. Os níveis são os do pedido do dono:
--    crítico (gasto sem venda, ROAS < 1), abaixo da meta (ROAS < 80% da meta
--    da própria campanha), atenção (CPC sobe e conversão cai; gasto sobe e
--    ROAS cai) e oportunidade de escala (acima da meta, no teto do orçamento,
--    vendendo). Campanha que não está ativa vira "pausada", fora dos alertas.
--    CTR e conversão são comparados com a MEDIANA das campanhas da
--    empresa na mesma semana -- não com número fixo. A margem não entra aqui:
--    a API não diz que produtos cada campanha vendeu, e a tela aplica a margem
--    média da empresa como premissa declarada.

-- ── get_ads_overview: + dias_pendentes ─────────────────────────────────────
create or replace function public.get_ads_overview(
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
as $fn$
declare
  resultado jsonb;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  with contas as (
    -- RLS de ml_accounts decide o que a pessoa ve; o filtro de conta estreita.
    select a.id, a.label, a.status as conta_status
    from public.ml_accounts a
    where (p_ml_account_id is null or a.id = p_ml_account_id)
  ),
  metricas as (
    select m.*
    from public.daily_ads_campaign_metrics m
    join contas c on c.id = m.ml_account_id
    where m.metric_date between p_date_from and p_date_to
  ),
  receita as (
    -- A receita bruta das vendas validas, para o TACoS (5.2), mesmas contas e dias.
    select coalesce(sum(d.gross_revenue), 0) as receita_bruta
    from public.daily_account_metrics d
    join contas c on c.id = d.ml_account_id
    where d.metric_date between p_date_from and p_date_to
  ),
  por_campanha as (
    select
      m.ml_account_id, m.campaign_id,
      sum(m.cost) as investimento, sum(m.total_amount) as receita_ads,
      sum(m.direct_amount) as receita_direta, sum(m.indirect_amount) as receita_indireta,
      sum(m.clicks) as cliques, sum(m.prints) as impressoes, sum(m.units) as unidades,
      count(*) as dias
    from metricas m
    group by m.ml_account_id, m.campaign_id
  ),
  resumo as (
    select
      coalesce(sum(m.cost), 0) as investimento,
      coalesce(sum(m.total_amount), 0) as receita_ads,
      coalesce(sum(m.direct_amount), 0) as receita_direta,
      coalesce(sum(m.indirect_amount), 0) as receita_indireta,
      coalesce(sum(m.clicks), 0) as cliques,
      coalesce(sum(m.prints), 0) as impressoes,
      coalesce(sum(m.units), 0) as unidades,
      count(distinct (m.ml_account_id, m.campaign_id)) as campanhas_com_metrica
    from metricas m
  ),
  -- D-398: os últimos dias fechados, somando as contas do recorte, para achar
  -- os que ainda chegaram sem venda atribuída. Independe do período pedido.
  recentes as materialized (
    select m.metric_date, sum(m.cost) as custo, sum(m.total_amount) as vendas, sum(m.prints) as impressoes
    from public.daily_ads_campaign_metrics m
    join contas c on c.id = m.ml_account_id
    where m.metric_date >= v_hoje - 10
      and m.metric_date < v_hoje
    group by m.metric_date
  ),
  pendentes as (
    select coalesce(jsonb_agg(r.metric_date order by r.metric_date), '[]'::jsonb) as dias
    from recentes r
    where r.custo > 0
      and r.metric_date > coalesce(
        (select max(x.metric_date) from recentes x where x.vendas > 0 and x.impressoes > 0),
        v_hoje - 11
      )
  )
  select jsonb_build_object(
    'resumo', (
      select jsonb_build_object(
        'investimento', round(r.investimento, 2),
        'receita_ads', round(r.receita_ads, 2),
        'receita_direta', round(r.receita_direta, 2),
        'receita_indireta', round(r.receita_indireta, 2),
        'cliques', r.cliques,
        'impressoes', r.impressoes,
        'unidades', r.unidades,
        'campanhas_com_metrica', r.campanhas_com_metrica,
        'acos', round(r.investimento / nullif(r.receita_ads, 0), 4),
        'roas', round(r.receita_ads / nullif(r.investimento, 0), 2),
        'ctr', round(r.cliques::numeric / nullif(r.impressoes, 0), 4),
        'cpc', round(r.investimento / nullif(r.cliques, 0), 2),
        'receita_bruta', round(rb.receita_bruta, 2),
        'tacos', round(r.investimento / nullif(rb.receita_bruta, 0), 4)
      )
      from resumo r cross join receita rb
    ),
    'campanhas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'ml_account_id', p.ml_account_id,
          'conta', c.label,
          'campaign_id', p.campaign_id,
          'nome', coalesce(ca.name, 'campanha ' || p.campaign_id::text),
          'status', ca.status,
          'estrategia', ca.strategy,
          'orcamento', ca.budget,
          'roas_alvo', ca.roas_target,
          'investimento', round(p.investimento, 2),
          'receita_ads', round(p.receita_ads, 2),
          'receita_direta', round(p.receita_direta, 2),
          'receita_indireta', round(p.receita_indireta, 2),
          'cliques', p.cliques,
          'impressoes', p.impressoes,
          'unidades', p.unidades,
          'acos', round(p.investimento / nullif(p.receita_ads, 0), 4),
          'roas', round(p.receita_ads / nullif(p.investimento, 0), 2)
        ) order by p.investimento desc, p.receita_ads desc)
      from por_campanha p
      join contas c on c.id = p.ml_account_id
      left join public.ads_campaigns ca
        on ca.ml_account_id = p.ml_account_id and ca.campaign_id = p.campaign_id
    ), '[]'::jsonb),
    'diario', coalesce((
      select jsonb_agg(jsonb_build_object(
          'dia', d.metric_date, 'investimento', round(d.investimento, 2), 'receita_ads', round(d.receita_ads, 2)
        ) order by d.metric_date)
      from (
        select m.metric_date, sum(m.cost) as investimento, sum(m.total_amount) as receita_ads
        from metricas m group by m.metric_date
      ) d
    ), '[]'::jsonb),
    'contas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'ml_account_id', c.id,
          'conta', c.label,
          'ads', coalesce(ad.status, 'nao_verificado'),
          'verificado_em', ad.checked_at
        ) order by c.label)
      from contas c
      left join public.ads_advertisers ad on ad.ml_account_id = c.id
      where c.conta_status = 'CONNECTED'
    ), '[]'::jsonb),
    'dias_pendentes', (select p.dias from pendentes p),
    'sincronizado_em', (
      select max(m.synced_at)
      from public.daily_ads_campaign_metrics m
      join contas c on c.id = m.ml_account_id
    )
  )
  into resultado;

  return resultado;
end
$fn$;

comment on function public.get_ads_overview(date, date, uuid) is
  'Mercado Ads no /faturamento (D-363): resumo (investimento, receita com Ads, ACOS, ROAS, CTR, CPC, TACoS contra a receita bruta das vendas validas), campanhas ordenadas por investimento, serie diaria e o estado de Product Ads por conta conectada. Razoes sobre as somas, NULL com denominador zero. D-398: dias_pendentes = dias fechados com gasto que o Mercado Livre ainda publicou sem venda atribuida. security invoker: RLS por conta.';

-- ── get_sinais_ads ─────────────────────────────────────────────────────────
create or replace function public.get_sinais_ads(
  p_organization_id uuid,
  p_hoje date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_fim date;
  v_pendentes jsonb;
begin
  -- O último dia consolidado da empresa: antes de hoje, com venda atribuída e
  -- impressão. Os dias com gasto depois dele são os pendentes (cabeçalho).
  with recentes as (
    select m.metric_date, sum(m.cost) as custo, sum(m.total_amount) as vendas, sum(m.prints) as impressoes
    from public.daily_ads_campaign_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date >= v_hoje - 21
      and m.metric_date < v_hoje
    group by m.metric_date
  )
  select
    (select max(r.metric_date) from recentes r where r.vendas > 0 and r.impressoes > 0),
    coalesce((
      select jsonb_agg(r.metric_date order by r.metric_date)
      from recentes r
      where r.custo > 0
        and r.metric_date > coalesce(
          (select max(x.metric_date) from recentes x where x.vendas > 0 and x.impressoes > 0),
          v_hoje - 22)
    ), '[]'::jsonb)
  into v_fim, v_pendentes;

  if v_fim is null then
    return jsonb_build_object(
      'janela', jsonb_build_object('inicio', null, 'fim', null, 'anterior_inicio', null, 'anterior_fim', null,
                                   'dias_pendentes', v_pendentes),
      'referencias', jsonb_build_object('ctr_mediano', null, 'conversao_mediana', null),
      'resumo', jsonb_build_object('campanhas', 0, 'critico', 0, 'abaixo_meta', 0, 'atencao', 0, 'escala', 0, 'normal', 0, 'pausada', 0,
                                   'investimento', 0, 'receita_ads', 0, 'roas', null,
                                   'investimento_anterior', 0, 'receita_ads_anterior', 0, 'roas_anterior', null),
      'campanhas', '[]'::jsonb
    );
  end if;

  return (
  with semanas as materialized (
    select
      m.ml_account_id,
      m.campaign_id,
      sum(m.cost) filter (where m.metric_date > v_fim - 7) as custo,
      sum(m.total_amount) filter (where m.metric_date > v_fim - 7) as receita,
      sum(m.units) filter (where m.metric_date > v_fim - 7) as unidades,
      sum(m.clicks) filter (where m.metric_date > v_fim - 7) as cliques,
      sum(m.prints) filter (where m.metric_date > v_fim - 7) as impressoes,
      count(*) filter (where m.metric_date > v_fim - 7) as dias,
      sum(m.cost) filter (where m.metric_date <= v_fim - 7) as custo_ant,
      sum(m.total_amount) filter (where m.metric_date <= v_fim - 7) as receita_ant,
      sum(m.units) filter (where m.metric_date <= v_fim - 7) as unidades_ant,
      sum(m.clicks) filter (where m.metric_date <= v_fim - 7) as cliques_ant,
      sum(m.prints) filter (where m.metric_date <= v_fim - 7) as impressoes_ant
    from public.daily_ads_campaign_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > v_fim - 14
      and m.metric_date <= v_fim
    group by m.ml_account_id, m.campaign_id
  ),
  -- Dias no teto: gasto de pelo menos 90% do orçamento DIÁRIO de hoje. O
  -- orçamento é o da última leitura, não o de cada dia (ressalva na tela).
  teto as (
    select m.ml_account_id, m.campaign_id, count(*) as dias_no_teto
    from public.daily_ads_campaign_metrics m
    join public.ads_campaigns ca on ca.ml_account_id = m.ml_account_id and ca.campaign_id = m.campaign_id
    where m.organization_id = p_organization_id
      and m.metric_date > v_fim - 7
      and m.metric_date <= v_fim
      and ca.budget > 0
      and m.cost >= 0.9 * ca.budget
    group by m.ml_account_id, m.campaign_id
  ),
  medidas as materialized (
    select
      s.*,
      a.label as conta,
      ca.name as nome,
      ca.status,
      ca.strategy as estrategia,
      ca.budget as orcamento,
      ca.roas_target as roas_alvo,
      ca.acos_target as acos_alvo,
      coalesce(t.dias_no_teto, 0) as dias_no_teto,
      s.receita / nullif(s.custo, 0) as roas,
      s.custo / nullif(s.receita, 0) as acos,
      s.cliques::numeric / nullif(s.impressoes, 0) as ctr,
      s.custo / nullif(s.cliques, 0) as cpc,
      s.unidades::numeric / nullif(s.cliques, 0) as conversao,
      s.custo / nullif(s.unidades, 0) as cpa,
      s.receita / nullif(s.unidades, 0) as ticket,
      s.custo / 7 / nullif(ca.budget, 0) as uso_orcamento,
      s.receita_ant / nullif(s.custo_ant, 0) as roas_ant,
      s.custo_ant / nullif(s.cliques_ant, 0) as cpc_ant,
      s.unidades_ant::numeric / nullif(s.cliques_ant, 0) as conversao_ant
    from semanas s
    join public.ml_accounts a on a.id = s.ml_account_id
    left join public.ads_campaigns ca on ca.ml_account_id = s.ml_account_id and ca.campaign_id = s.campaign_id
    left join teto t on t.ml_account_id = s.ml_account_id and t.campaign_id = s.campaign_id
    where coalesce(s.custo, 0) > 0 or coalesce(s.custo_ant, 0) > 0
  ),
  -- As referências da semana: a mediana das campanhas com volume, não um
  -- número fixo. CTR baixo e conversão baixa são "contra as suas campanhas".
  referencias as (
    select
      percentile_cont(0.5) within group (order by m.ctr) filter (where m.impressoes >= 1000) as ctr_mediano,
      percentile_cont(0.5) within group (order by m.conversao) filter (where m.cliques >= 50) as conversao_mediana
    from medidas m
  ),
  sinais as (
    select
      m.*,
      (coalesce(m.custo, 0) >= greatest(50, coalesce(m.orcamento, 0)) and coalesce(m.unidades, 0) = 0) as sem_venda,
      (coalesce(m.custo, 0) >= 50 and coalesce(m.unidades, 0) > 0 and m.roas < 1) as roas_abaixo_de_1,
      (coalesce(m.custo, 0) >= 50 and coalesce(m.unidades, 0) > 0 and m.roas_alvo > 0 and m.roas < 0.8 * m.roas_alvo) as abaixo_da_meta,
      (coalesce(m.cliques, 0) >= 100 and coalesce(m.cliques_ant, 0) >= 100
        and m.cpc >= 1.2 * m.cpc_ant and m.conversao <= 0.85 * m.conversao_ant) as cpc_sobe_conversao_cai,
      (coalesce(m.custo_ant, 0) >= 100 and m.custo >= 1.2 * m.custo_ant
        and m.roas_ant > 0 and m.roas <= 0.85 * m.roas_ant) as gasto_sobe_roas_cai,
      (coalesce(m.impressoes, 0) >= 1000 and r.ctr_mediano > 0 and m.ctr < 0.7 * r.ctr_mediano) as ctr_baixo,
      (coalesce(m.cliques, 0) >= 100 and r.conversao_mediana > 0 and m.conversao < 0.6 * r.conversao_mediana) as conversao_baixa,
      (m.status = 'active' and m.roas_alvo > 0 and m.roas >= m.roas_alvo
        and (m.uso_orcamento >= 0.9 or m.dias_no_teto >= 4) and coalesce(m.unidades, 0) >= 5) as no_teto_acima_da_meta
    from medidas m
    cross join referencias r
  ),
  classificado as materialized (
    select
      s.*,
      case
        -- Pausada: quem pausou já agiu; o sinal da semana em que gastou não
        -- vira alerta, e a campanha fica na tabela.
        when s.status is distinct from 'active' then 'pausada'
        when s.sem_venda or s.roas_abaixo_de_1 then 'critico'
        when s.abaixo_da_meta then 'abaixo_meta'
        when s.cpc_sobe_conversao_cai or s.gasto_sobe_roas_cai then 'atencao'
        when s.no_teto_acima_da_meta then 'escala'
        else 'normal'
      end as nivel
    from sinais s
  )
  select jsonb_build_object(
    'janela', jsonb_build_object(
      'inicio', v_fim - 6,
      'fim', v_fim,
      'anterior_inicio', v_fim - 13,
      'anterior_fim', v_fim - 7,
      'dias_pendentes', v_pendentes
    ),
    'referencias', (
      select jsonb_build_object(
        'ctr_mediano', round(r.ctr_mediano::numeric, 4),
        'conversao_mediana', round(r.conversao_mediana::numeric, 4)
      )
      from referencias r
    ),
    'resumo', (
      select jsonb_build_object(
        'campanhas', count(*),
        'critico', count(*) filter (where c.nivel = 'critico'),
        'abaixo_meta', count(*) filter (where c.nivel = 'abaixo_meta'),
        'atencao', count(*) filter (where c.nivel = 'atencao'),
        'escala', count(*) filter (where c.nivel = 'escala'),
        'normal', count(*) filter (where c.nivel = 'normal'),
        'pausada', count(*) filter (where c.nivel = 'pausada'),
        'investimento', round(coalesce(sum(c.custo), 0), 2),
        'receita_ads', round(coalesce(sum(c.receita), 0), 2),
        'roas', round(sum(c.receita) / nullif(sum(c.custo), 0), 2),
        'investimento_anterior', round(coalesce(sum(c.custo_ant), 0), 2),
        'receita_ads_anterior', round(coalesce(sum(c.receita_ant), 0), 2),
        'roas_anterior', round(sum(c.receita_ant) / nullif(sum(c.custo_ant), 0), 2)
      )
      from classificado c
    ),
    'campanhas', coalesce((
      select jsonb_agg(jsonb_build_object(
          'ml_account_id', c.ml_account_id,
          'conta', c.conta,
          'campaign_id', c.campaign_id,
          'nome', coalesce(c.nome, 'campanha ' || c.campaign_id::text),
          'status', c.status,
          'estrategia', c.estrategia,
          'orcamento', c.orcamento,
          'roas_alvo', c.roas_alvo,
          'acos_alvo', c.acos_alvo,
          'nivel', c.nivel,
          'investimento', round(coalesce(c.custo, 0), 2),
          'receita_ads', round(coalesce(c.receita, 0), 2),
          'unidades', coalesce(c.unidades, 0),
          'cliques', coalesce(c.cliques, 0),
          'impressoes', coalesce(c.impressoes, 0),
          'dias', c.dias,
          'dias_no_teto', c.dias_no_teto,
          'roas', round(c.roas, 2),
          'acos', round(c.acos, 4),
          'ctr', round(c.ctr, 4),
          'cpc', round(c.cpc, 2),
          'conversao', round(c.conversao, 4),
          'cpa', round(c.cpa, 2),
          'ticket', round(c.ticket, 2),
          'uso_orcamento', round(c.uso_orcamento, 4),
          'investimento_anterior', round(coalesce(c.custo_ant, 0), 2),
          'receita_ads_anterior', round(coalesce(c.receita_ant, 0), 2),
          'unidades_anterior', coalesce(c.unidades_ant, 0),
          'cliques_anterior', coalesce(c.cliques_ant, 0),
          'roas_anterior', round(c.roas_ant, 2),
          'cpc_anterior', round(c.cpc_ant, 2),
          'conversao_anterior', round(c.conversao_ant, 4),
          'sinais', jsonb_build_object(
            'sem_venda', c.sem_venda,
            'roas_abaixo_de_1', c.roas_abaixo_de_1,
            'abaixo_da_meta', c.abaixo_da_meta,
            'cpc_sobe_conversao_cai', c.cpc_sobe_conversao_cai,
            'gasto_sobe_roas_cai', c.gasto_sobe_roas_cai,
            'ctr_baixo', c.ctr_baixo,
            'conversao_baixa', c.conversao_baixa,
            'no_teto_acima_da_meta', c.no_teto_acima_da_meta
          )
        ) order by
          case c.nivel when 'critico' then 1 when 'abaixo_meta' then 2 when 'atencao' then 3 when 'escala' then 4 when 'normal' then 5 else 6 end,
          c.custo desc nulls last, c.campaign_id)
      from classificado c
    ), '[]'::jsonb)
  )
  );
end
$fn$;

comment on function public.get_sinais_ads(uuid, date) is
  'D-398: sinais de Ads por campanha -- 7 dias consolidados contra os 7 anteriores: gasto sem venda, ROAS < 1, ROAS abaixo de 80% da meta da campanha, CPC sobe e conversão cai, gasto sobe e ROAS cai, e no teto do orçamento acima da meta. CTR e conversão contra a mediana das campanhas da empresa. security invoker.';

revoke all on function public.get_sinais_ads(uuid, date) from public, anon;
grant execute on function public.get_sinais_ads(uuid, date) to authenticated, service_role;

-- O catálogo espelha docs/METRICS.md 5M (D-023).
insert into public.metric_definitions
  (id, name, formula, source, granularities, inclusions, exclusions,
   cancellation_treatment, timezone, definition_updated_on)
values
  ('ctr_ads', 'CTR do Ads', 'cliques ÷ impressões', 'daily_ads_campaign_metrics', array['account', 'organization'],
   'Product Ads, dias consolidados.', 'Sem impressão: NULL.', 'included', 'America/Sao_Paulo', date '2026-09-23'),
  ('cpc_ads', 'CPC do Ads', 'investimento_ads ÷ cliques', 'daily_ads_campaign_metrics', array['account', 'organization'],
   'Product Ads.', 'Sem clique: NULL.', 'included', 'America/Sao_Paulo', date '2026-09-23'),
  ('conversao_ads', 'Conversão do Ads', 'unidades atribuídas ÷ cliques', 'daily_ads_campaign_metrics', array['account', 'organization'],
   'Unidades diretas + indiretas atribuídas pelo Mercado Livre; dias consolidados.',
   'Não é conversão de pedido: é unidade por clique. Sem clique: NULL.', 'included', 'America/Sao_Paulo', date '2026-09-23'),
  ('cpa_ads', 'Custo por venda do Ads', 'investimento_ads ÷ unidades atribuídas', 'daily_ads_campaign_metrics', array['account', 'organization'],
   'Dias consolidados.', 'Sem unidade vendida: NULL.', 'included', 'America/Sao_Paulo', date '2026-09-23'),
  ('uso_orcamento_ads', 'Uso do orçamento', 'investimento dos 7 dias ÷ 7 ÷ orçamento diário da campanha; dias no teto = dias com gasto ≥ 90% do orçamento',
   'daily_ads_campaign_metrics + ads_campaigns.budget', array['account'],
   'O orçamento é o da última leitura da campanha.', 'Campanha sem orçamento: NULL.', 'included', 'America/Sao_Paulo', date '2026-09-23'),
  ('nivel_sinal_ads', 'Sinal da campanha de Ads',
   'pausada (não ativa, fora dos alertas); crítico (gasto ≥ max(R$ 50, orçamento) sem venda, ou ROAS < 1) > abaixo da meta (ROAS < 80% do roas_target) > atenção (CPC +20% com conversão −15%; gasto +20% com ROAS −15%) > oportunidade de escala (ativa, ROAS ≥ meta, uso ≥ 90% ou 4 dias no teto, 5 unidades) > normal',
   'get_sinais_ads', array['account'],
   '7 dias consolidados contra os 7 anteriores.', 'Dias que o Mercado Livre ainda não consolidou (venda atribuída pendente).',
   'included', 'America/Sao_Paulo', date '2026-09-23'),
  ('lucro_estimado_apos_ads', 'Lucro estimado após Ads',
   'vendas com Ads × margem média da empresa no período − investimento; margem após Ads = margem média − ACOS; ROAS de equilíbrio = 1 ÷ margem média',
   'get_sinais_ads + get_faturamento (margem_apos_imposto, ou margem_venda sem alíquota)', array['account'],
   'Premissa: os produtos da campanha têm a margem média da empresa -- a API não diz quais produtos cada campanha vendeu.',
   'Sem margem conhecida no período: NULL.', 'included', 'America/Sao_Paulo', date '2026-09-23');
