-- ============================================================
-- LIMITAR A CENTRAL DE ALERTAS NO BANCO
-- ============================================================
--
-- Problema corrigido:
--
-- get_operational_alerts_data (20260817121000_add_compact_stock_read_models.sql:132-175)
-- serializa TODA a lista de alertas do escopo em um único JSON. A
-- aplicação então filtra por severidade e texto em JavaScript e só depois
-- corta em 250 linhas (operational-alerts-view.tsx:191-201). Medido em
-- 17/08/2026: 6.402 alertas na tabela. O payload e o tempo crescem sem
-- teto conforme o histórico acumula.
--
-- Esta função move escopo, severidade, busca e limite para o SQL,
-- preservando exatamente a semântica atual da tela.
--
-- Sobre a busca: a UI pesquisa em SKU, nome do produto, título e
-- categoria. Título e categoria não existem no banco — são derivados de
-- alert_type por um mapa estático em TypeScript
-- (get-operational-alerts.ts:60+). Por isso a aplicação resolve quais
-- alert_type casam com o texto e os envia em matching_alert_types, que é
-- combinado por OR com o ILIKE de SKU e nome. Sem isso, uma busca por
-- "Full" ou "Kits" deixaria de encontrar resultados.
--
-- total_matching é devolvido separadamente para a tela poder informar
-- quantos alertas existem além dos exibidos.

create or replace function public.get_operational_alerts_page(
  target_organization_id uuid,
  requested_scope text default 'open',
  requested_severity text default 'all',
  requested_search text default null,
  matching_alert_types text[] default null,
  requested_limit integer default 250
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  search_pattern text;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if requested_scope not in ('open', 'resolved', 'all') then
    raise exception 'invalid_alert_scope';
  end if;

  if requested_severity not in ('all', 'critical', 'warning', 'info') then
    raise exception 'invalid_alert_severity';
  end if;

  if requested_limit < 1 or requested_limit > 500 then
    raise exception 'invalid_result_limit';
  end if;

  search_pattern := case
    when requested_search is null or btrim(requested_search) = '' then null
    else '%' || btrim(requested_search) || '%'
  end;

  return jsonb_build_object(
    -- Resumo global: independe de escopo, severidade e busca, exatamente
    -- como na função anterior.
    'summary', (
      select jsonb_build_object(
        'open', count(*) filter (where alert.status = 'open'),
        'critical', count(*) filter (
          where alert.status = 'open' and alert.severity = 'critical'
        ),
        'warning', count(*) filter (
          where alert.status = 'open' and alert.severity = 'warning'
        ),
        'info', count(*) filter (
          where alert.status = 'open' and alert.severity = 'info'
        ),
        'resolved', count(*) filter (where alert.status = 'resolved')
      )
      from public.operational_alerts as alert
      where alert.organization_id = target_organization_id
    ),

    'totalMatching', (
      select count(*)
      from public.operational_alerts as alert
      join public.products as product
        on product.organization_id = alert.organization_id
       and product.id = alert.product_id
      where alert.organization_id = target_organization_id
        and (requested_scope = 'all' or alert.status = requested_scope)
        and (requested_severity = 'all' or alert.severity = requested_severity)
        and (
          search_pattern is null
          or product.sku ilike search_pattern
          or product.name ilike search_pattern
          or (
            matching_alert_types is not null
            and alert.alert_type = any (matching_alert_types)
          )
        )
    ),

    'alerts', coalesce((
      select jsonb_agg(
        to_jsonb(page_row)
        order by page_row.last_seen_at desc, page_row.id
      )
      from (
        select
          alert.id,
          alert.product_id,
          alert.alert_type,
          alert.severity,
          alert.status,
          alert.evidence,
          alert.suggested_action_code,
          alert.last_seen_at,
          alert.resolved_at,
          product.sku,
          product.name as product_name
        from public.operational_alerts as alert
        join public.products as product
          on product.organization_id = alert.organization_id
         and product.id = alert.product_id
        where alert.organization_id = target_organization_id
          and (requested_scope = 'all' or alert.status = requested_scope)
          and (requested_severity = 'all' or alert.severity = requested_severity)
          and (
            search_pattern is null
            or product.sku ilike search_pattern
            or product.name ilike search_pattern
            or (
              matching_alert_types is not null
              and alert.alert_type = any (matching_alert_types)
            )
          )
        order by alert.last_seen_at desc, alert.id
        limit requested_limit
      ) as page_row
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_operational_alerts_page(
  uuid, text, text, text, text[], integer
) from public, anon;

grant execute on function public.get_operational_alerts_page(
  uuid, text, text, text, text[], integer
) to authenticated;

-- Índice para o caminho quente da tela: alertas de uma organização
-- ordenados por recência, com escopo/severidade como filtros.
create index if not exists operational_alerts_org_last_seen_idx
  on public.operational_alerts (organization_id, last_seen_at desc, id);

analyze public.operational_alerts;
