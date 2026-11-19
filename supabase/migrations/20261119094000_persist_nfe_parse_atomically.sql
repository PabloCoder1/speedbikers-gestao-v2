begin;

create function public.persist_nfe_parse(
  p_document_id uuid,
  p_parse_version timestamptz,
  p_header jsonb,
  p_items jsonb,
  p_parsed_at timestamptz,
  p_error text,
  p_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  header public.documents;
  item_count integer;
begin
  select d.* into header
    from public.documents d
    where d.id = p_document_id
      and d.status = 'PARSING'
      and d.updated_at = p_parse_version
      and d.parsed_at is null
    for update;

  if not found then
    return false;
  end if;

  -- Quando o cabeçalho da recusa não passa nas constraints, a regravação
  -- usa os campos existentes para que a nota ainda mostre o motivo da recusa.
  header := pg_catalog.jsonb_populate_record(header, coalesce(p_header, '{}'::jsonb));

  delete from public.document_items where document_id = p_document_id;

  insert into public.document_items (
    document_id, position, supplier_code, ean, description, ncm, cfop,
    unit, quantity, unit_value, total_value
  )
  select p_document_id, i.position, i.supplier_code, i.ean, i.description, i.ncm, i.cfop,
    i.unit, i.quantity, i.unit_value, i.total_value
  from pg_catalog.jsonb_to_recordset(p_items) as i(
    position integer, supplier_code text, ean text, description text, ncm text, cfop text,
    unit text, quantity numeric, unit_value numeric, total_value numeric
  );
  get diagnostics item_count = row_count;

  update public.documents
    set document_type = header.document_type,
        access_key = header.access_key,
        operation_type = header.operation_type,
        document_number = header.document_number,
        series = header.series,
        issue_date = header.issue_date,
        issuer_cnpj = header.issuer_cnpj,
        issuer_name = header.issuer_name,
        recipient_cnpj = header.recipient_cnpj,
        recipient_name = header.recipient_name,
        reference = header.reference,
        intermediary_cnpj = header.intermediary_cnpj,
        status = case when p_parsed_at is null then 'FAILED' else 'PARSED' end,
        total_items = case when p_parsed_at is not null then item_count end,
        resolved_items = case when p_parsed_at is not null then 0 end,
        parsed_at = p_parsed_at,
        last_error = p_error,
        last_error_code = p_error_code
    where id = p_document_id;

  return true;
end;
$$;

comment on function public.persist_nfe_parse(uuid, timestamptz, jsonb, jsonb, timestamptz, text, text)
  is 'Worker de NF-e. Substitui os itens e encerra a leitura em uma transação, condicionada à versão que iniciou o parse.';

revoke all on function public.persist_nfe_parse(uuid, timestamptz, jsonb, jsonb, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.persist_nfe_parse(uuid, timestamptz, jsonb, jsonb, timestamptz, text, text)
  to service_role;

commit;
