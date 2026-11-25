-- O arquivo guarda somente entregas já lidas. O evento e as permissões
-- atuais continuam em domain_events, sem copiar payload ou regras de conta.
create schema notification_archive;
revoke all on schema notification_archive from public, anon, authenticated;

create table notification_archive.recipients (
  notification_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  domain_event_id uuid not null references public.domain_events(id) on delete restrict,
  read_at timestamptz not null,
  created_at timestamptz not null,
  primary key (notification_id, user_id)
);

create index notification_archive_recipients_timeline_idx
  on notification_archive.recipients (user_id, created_at desc, notification_id desc);

alter table notification_archive.recipients enable row level security;
create policy recipients_select_own
  on notification_archive.recipients for select to authenticated
  using (user_id = (select auth.uid()));

-- A view precisa do SELECT na relação base. A falta de USAGE mantém
-- o schema inacessível diretamente e o join aplica a RLS do evento.
revoke all on notification_archive.recipients from public, anon, authenticated;
grant select on notification_archive.recipients to authenticated;

create view public.notification_history with (security_invoker = true) as
select r.notification_id, r.read_at, r.created_at,
       e.event_type, e.entity_type, e.entity_id, e.severity,
       e.occurred_at, e.before, e.after, e.ml_account_id, e.shopee_shop_id,
       m.label as account_label, false as archived
  from public.notification_recipients r
  join public.notifications n on n.id = r.notification_id
  join public.domain_events e on e.id = n.domain_event_id
  left join public.ml_accounts m on m.id = e.ml_account_id
union all
select a.notification_id, a.read_at, a.created_at,
       e.event_type, e.entity_type, e.entity_id, e.severity,
       e.occurred_at, e.before, e.after, e.ml_account_id, e.shopee_shop_id,
       m.label as account_label, true as archived
  from notification_archive.recipients a
  join public.domain_events e on e.id = a.domain_event_id
  left join public.ml_accounts m on m.id = e.ml_account_id
 where not exists (
   select 1 from public.notification_recipients r
    where r.notification_id = a.notification_id and r.user_id = a.user_id
 );

revoke all on public.notification_history from public, anon, authenticated, service_role;
grant select on public.notification_history to authenticated;

comment on view public.notification_history is
  'Central: histórico ativo e arquivado por destinatário, com permissões atuais do evento.';

-- Limita os dois ramos antes de mesclar a página. Ordenar a união inteira
-- faz a primeira página materializar o histórico, mesmo com o arquivo vazio.
create function public.list_notification_history(
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
  return query execute $page$
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
    (select h.* from public.notification_history h
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
  $page$ using p_offset, p_limit, p_unread, p_severity, p_event_type_pattern, p_ml_account_id, p_shopee_shop_id;
end;
$$;

revoke all on function public.list_notification_history(bigint, integer, boolean, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_notification_history(bigint, integer, boolean, text, text, uuid, uuid)
  to authenticated;
