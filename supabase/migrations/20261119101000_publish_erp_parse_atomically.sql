begin;

create table private.erp_parse_chunks (
  batch_id uuid not null references public.erp_import_batches(id) on delete cascade,
  parse_version timestamptz not null,
  chunk_offset integer not null,
  rows jsonb not null,
  primary key (batch_id, parse_version, chunk_offset)
);

alter table private.erp_parse_chunks enable row level security;
revoke all on table private.erp_parse_chunks from public, anon, authenticated;
grant select, insert, update, delete on table private.erp_parse_chunks to service_role;

create function private.clear_erp_parse_chunks()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from private.erp_parse_chunks where batch_id = new.id;
  return new;
end;
$$;

revoke all on function private.clear_erp_parse_chunks() from public, anon, authenticated;

-- Descarta blocos abandonados assim que a tentativa muda ou sai de PARSING.
create trigger erp_import_batch_clear_parse_chunks
  after update on public.erp_import_batches
  for each row
  when (old.updated_at is distinct from new.updated_at or old.status is distinct from new.status)
  execute function private.clear_erp_parse_chunks();

create function public.stage_erp_parse_chunk(
  p_batch_id uuid,
  p_parse_version timestamptz,
  p_offset integer,
  p_rows jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.erp_import_batches b
    where b.id = p_batch_id
      and b.status = 'PARSING'
      and b.updated_at = p_parse_version
      and b.parsed_at is null
    for update;
  if not found then return false; end if;

  if p_offset is null or p_offset < 0 or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'bloco ERP inválido' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'bloco ERP deve ter entre 1 e 1000 linhas' using errcode = '22023';
  end if;

  insert into private.erp_parse_chunks (batch_id, parse_version, chunk_offset, rows)
    values (p_batch_id, p_parse_version, p_offset, p_rows)
    on conflict (batch_id, parse_version, chunk_offset)
    do update set rows = excluded.rows;
  return true;
end;
$$;

create function public.publish_erp_parse(
  p_batch_id uuid,
  p_parse_version timestamptz,
  p_expected_rows integer,
  p_parsed_at timestamptz
)
returns table (total_rows integer, ok_rows integer, skipped_rows integer, invalid_rows integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  first_row integer;
  last_row integer;
begin
  perform 1 from public.erp_import_batches b
    where b.id = p_batch_id
      and b.status = 'PARSING'
      and b.updated_at = p_parse_version
      and b.parsed_at is null
    for update;
  if not found then return; end if;

  if p_expected_rows is null or p_expected_rows < 0 or p_parsed_at is null then
    raise exception 'publicação ERP inválida' using errcode = '22023';
  end if;

  delete from public.erp_import_rows where batch_id = p_batch_id;
  delete from public.erp_stock_snapshots where batch_id = p_batch_id;

  with inserted as (
    insert into public.erp_import_rows (batch_id, row_number, status, reason, sku_key, payload)
      select p_batch_id, r.row_number, r.status, r.reason, r.sku_key, r.payload
        from private.erp_parse_chunks c
        cross join lateral jsonb_to_recordset(c.rows) as r(
          row_number integer, status text, reason text, sku_key text, payload jsonb
        )
        where c.batch_id = p_batch_id and c.parse_version = p_parse_version
        order by r.row_number
      returning row_number, status
  )
  select count(*)::integer,
         (count(*) filter (where status = 'OK'))::integer,
         (count(*) filter (where status = 'SKIPPED'))::integer,
         (count(*) filter (where status = 'INVALID'))::integer,
         min(row_number), max(row_number)
    into total_rows, ok_rows, skipped_rows, invalid_rows, first_row, last_row
    from inserted;

  -- A chave única já garante posições distintas. Quantidade e extremos
  -- garantem todas as posições, incluindo a primeira linha após o cabeçalho.
  if total_rows <> p_expected_rows
    or (total_rows > 0 and (first_row <> 2 or last_row::bigint <> p_expected_rows::bigint + 1)) then
    raise exception 'conferência ERP incompleta' using errcode = '22023';
  end if;

  update public.erp_import_batches
    set total_rows = publish_erp_parse.total_rows,
        ok_rows = publish_erp_parse.ok_rows,
        skipped_rows = publish_erp_parse.skipped_rows,
        invalid_rows = publish_erp_parse.invalid_rows,
        status = 'PARSED',
        parsed_at = p_parsed_at,
        last_error = null
    where id = p_batch_id;

  return next;
end;
$$;

revoke all on function public.stage_erp_parse_chunk(uuid, timestamptz, integer, jsonb) from public, anon, authenticated;
revoke all on function public.publish_erp_parse(uuid, timestamptz, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.stage_erp_parse_chunk(uuid, timestamptz, integer, jsonb) to service_role;
grant execute on function public.publish_erp_parse(uuid, timestamptz, integer, timestamptz) to service_role;

commit;
