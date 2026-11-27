-- Os três vínculos consultados são únicos. Os LIMIT 1 mantêm a ordem
-- do índice de destinatário e permitem encerrar a leitura depois da página.
create view public.notification_archive_visible with (security_invoker = true) as
select a.notification_id, a.read_at, a.created_at,
       e.event_type, e.entity_type, e.entity_id, e.severity,
       e.occurred_at, e.before, e.after, e.ml_account_id, e.shopee_shop_id,
       m.label as account_label, true as archived
  from notification_archive.recipients a
  join lateral (
    select e.* from public.domain_events e where e.id = a.domain_event_id limit 1
  ) e on true
  left join lateral (
    select true as present from public.notification_recipients r
     where r.notification_id = a.notification_id and r.user_id = a.user_id limit 1
  ) active on true
  left join lateral (
    select m.label from public.ml_accounts m where m.id = e.ml_account_id limit 1
  ) m on true
 where active.present is null;

revoke all on public.notification_archive_visible from public, anon, authenticated, service_role;
grant select on public.notification_archive_visible to authenticated;

comment on view public.notification_archive_visible is
  'Ramo arquivado da Central, com permissões vigentes e preferência pelo vínculo ativo.';

-- Usa a ordem do arquivo nas primeiras páginas sem filtros. Nos recortes
-- seletivos e nas páginas profundas, preserva a consulta anterior.
create or replace function public.list_notification_history(
  p_offset bigint,
  p_limit integer,
  p_unread boolean,
  p_severity text default null,
  p_event_type_pattern text default null,
  p_ml_account_id uuid default null,
  p_shopee_shop_id uuid default null
)
returns setof public.notification_history
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  -- Replaneja com os valores desta chamada. Um plano genérico perde o caminho
  -- indexado para a primeira página quando combina os filtros opcionais.
  return query execute pg_catalog.format($page$
  select page.* from (
    (select r.notification_id, r.read_at, r.created_at,
            e.event_type, e.entity_type, e.entity_id, e.severity,
            e.occurred_at, e.before, e.after, e.ml_account_id, e.shopee_shop_id,
            m.label as account_label, false as archived
       from public.notification_recipients r
       join public.notifications n on n.id = r.notification_id
       join public.domain_events e on e.id = n.domain_event_id
       left join public.ml_accounts m on m.id = e.ml_account_id
      where ($3 is not true or r.read_at is null)
        and ($4 is null or e.severity = $4)
        and ($5 is null or e.event_type like $5)
        and ($6 is null or e.ml_account_id = $6)
        and ($7 is null or e.shopee_shop_id = $7)
      order by r.created_at desc, r.notification_id desc
      limit least(greatest($1, 0)::numeric + least(greatest($2, 1), 100), 9223372036854775807)::bigint)
    union all
    (select h.* from public.%I h
      where h.archived and $3 is not true
        and ($4 is null or h.severity = $4)
        and ($5 is null or h.event_type like $5)
        and ($6 is null or h.ml_account_id = $6)
        and ($7 is null or h.shopee_shop_id = $7)
      order by h.created_at desc, h.notification_id desc
      limit least(greatest($1, 0)::numeric + least(greatest($2, 1), 100), 9223372036854775807)::bigint)
  ) page
  order by created_at desc, notification_id desc
  offset greatest($1, 0)
  limit least(greatest($2, 1), 100)
  $page$, case
    when coalesce(p_offset, 0) <= 1000
      and p_severity is null and p_event_type_pattern is null
      and p_ml_account_id is null and p_shopee_shop_id is null
      then 'notification_archive_visible'
    else 'notification_history'
  end) using p_offset, p_limit, p_unread, p_severity, p_event_type_pattern, p_ml_account_id, p_shopee_shop_id;
end;
$$;
