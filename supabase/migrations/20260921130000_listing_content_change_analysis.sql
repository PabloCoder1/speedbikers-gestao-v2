-- D-390 — experimentos editoriais de anúncio.
--
-- O evento é observado pelo sync; o veredito só nasce após SETE dias civis
-- completos. Não declara causalidade quando preço, estoque/status ou outro
-- conteúdo mudou na janela: nesses casos a linha explica o bloqueio.

alter table public.listings
  add column picture_fingerprint text;

comment on column public.listings.picture_fingerprint is
  'IDs das fotos do ML, ordenados e unidos; usado somente para detectar troca editorial de foto, nunca mostrado ao usuário.';

create function public.get_listing_content_change_analysis(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_item_id text
)
returns table (
  occurred_at timestamptz,
  content_changed text[],
  baseline_units numeric,
  outcome_units numeric,
  baseline_visits numeric,
  outcome_visits numeric,
  units_change_ratio numeric,
  visits_change_ratio numeric,
  verdict text,
  blocked_reason text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with content_events as (
    select e.occurred_at,
           array_agg(e.event_type order by e.event_type) as content_changed
      from public.domain_events e
     where e.organization_id = p_organization_id
       and e.ml_account_id = p_ml_account_id
       and e.entity_type = 'listing'
       and e.entity_id = p_item_id
       and e.event_type in ('listing.title.changed', 'listing.picture.changed', 'listing.description.changed')
       -- sete dias completos terminam ontem; não analisar parcial de hoje.
       and e.occurred_at::date <= current_date - 8
     group by e.occurred_at
  ), evaluated as (
    select c.*,
      (select coalesce(sum(m.units_sold), 0)::numeric from public.daily_listing_metrics m
        where m.ml_account_id = p_ml_account_id and m.mlb_id = p_item_id and m.variation_id is null
          and m.metric_date between (c.occurred_at::date - 7) and (c.occurred_at::date - 1)) as baseline_units,
      (select coalesce(sum(m.units_sold), 0)::numeric from public.daily_listing_metrics m
        where m.ml_account_id = p_ml_account_id and m.mlb_id = p_item_id and m.variation_id is null
          and m.metric_date between (c.occurred_at::date + 1) and (c.occurred_at::date + 7)) as outcome_units,
      (select sum(v.visits)::numeric from public.daily_listing_visits v
        where v.ml_account_id = p_ml_account_id and v.item_id = p_item_id
          and v.metric_date between (c.occurred_at::date - 7) and (c.occurred_at::date - 1)) as baseline_visits,
      (select sum(v.visits)::numeric from public.daily_listing_visits v
        where v.ml_account_id = p_ml_account_id and v.item_id = p_item_id
          and v.metric_date between (c.occurred_at::date + 1) and (c.occurred_at::date + 7)) as outcome_visits,
      exists (select 1 from public.domain_events x where x.ml_account_id = p_ml_account_id and x.entity_type = 'listing' and x.entity_id = p_item_id
        and x.occurred_at::date between c.occurred_at::date and c.occurred_at::date + 7
        and x.event_type in ('listing.price.changed', 'listing.status.paused', 'listing.available_quantity.changed')) as has_confounder,
      cardinality(c.content_changed) > 1 as multiple_content_changes
    from content_events c
  )
  select occurred_at, content_changed, baseline_units, outcome_units, baseline_visits, outcome_visits,
    round((outcome_units - baseline_units) / nullif(baseline_units, 0), 4),
    round((outcome_visits - baseline_visits) / nullif(baseline_visits, 0), 4),
    case
      when has_confounder then 'blocked'
      when multiple_content_changes then 'blocked'
      when baseline_units < 3 or baseline_visits is null or baseline_visits = 0 or outcome_visits is null then 'insufficient_sample'
      when outcome_units <= baseline_units * 0.7 and outcome_visits <= baseline_visits * 0.75 then 'alert'
      else 'no_drop'
    end,
    case
      when has_confounder then 'Houve alteração de preço, estoque ou status nos mesmos 7 dias.'
      when multiple_content_changes then 'Mais de uma parte do conteúdo mudou no mesmo momento.'
      when baseline_units < 3 then 'Venda anterior insuficiente para uma comparação confiável.'
      when baseline_visits is null or baseline_visits = 0 or outcome_visits is null then 'Visitas insuficientes para confirmar queda de exposição.'
      else null
    end
  from evaluated
  order by occurred_at desc
  limit 10
$$;

comment on function public.get_listing_content_change_analysis(uuid, uuid, text) is
  'Compara sete dias antes/depois de alteração editorial. Só alerta com >=30% de queda em unidades e >=25% em visitas, sem confundidores; o resultado é evidência, não causalidade provada.';

revoke all on function public.get_listing_content_change_analysis(uuid, uuid, text) from public, anon;
grant execute on function public.get_listing_content_change_analysis(uuid, uuid, text) to authenticated, service_role;
