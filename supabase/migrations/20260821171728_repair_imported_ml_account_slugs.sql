-- Repara o único lote LINKS aplicado em Dev antes da correção de
-- storeLabel()/storeSlug(). O parser antigo preservou o trecho `ML-` do
-- prefixo `mercado-ML-` e criou quatro contas paralelas. Se os placeholders
-- não existirem (por exemplo, num ambiente novo), a migration é no-op.
--
-- A operação falha inteira se qualquer premissa observada em 2026-08-21
-- mudar. Isso evita apagar, por cascade, dados que tenham surgido entre a
-- conferência e a aplicação desta reparação.
do $$
declare
  target_organization_id constant uuid := '00000000-0000-4000-8000-000000000001';
  source_accounts integer;
  target_accounts integer;
  source_links bigint;
  target_links bigint;
  unexpected_dependencies bigint;
  moved_links bigint;
  removed_accounts bigint;
begin
  select count(*)
    into source_accounts
    from public.ml_accounts
   where organization_id = target_organization_id
     and slug in (
       'ml-speedbikers-loja-1',
       'ml-speedbikers-loja-2',
       'ml-sbmotos',
       'ml-gmr'
     );

  if source_accounts = 0 then
    return;
  end if;

  if source_accounts <> 4 then
    raise exception 'reparo de contas ML recusado: esperava 4 placeholders, encontrou %', source_accounts;
  end if;

  -- Serializa a conferência e a reparação contra qualquer escrita concorrente
  -- nas oito contas envolvidas.
  perform 1
    from public.ml_accounts
   where organization_id = target_organization_id
     and slug in (
       'ml-speedbikers-loja-1',
       'ml-speedbikers-loja-2',
       'ml-sbmotos',
       'ml-gmr',
       'speedbikers-loja-1',
       'speedbikers-loja-2',
       'sbmotos',
       'gmr'
     )
   for update;

  select count(*)
    into source_accounts
    from public.ml_accounts
   where organization_id = target_organization_id
     and slug in (
       'ml-speedbikers-loja-1',
       'ml-speedbikers-loja-2',
       'ml-sbmotos',
       'ml-gmr'
     )
     and created_by_import = true
     and status = 'PENDING';

  if source_accounts <> 4 then
    raise exception 'reparo de contas ML recusado: os 4 placeholders precisam ser PENDING e criados pelo import';
  end if;

  select count(*)
    into target_accounts
    from public.ml_accounts
   where organization_id = target_organization_id
     and slug in (
       'speedbikers-loja-1',
       'speedbikers-loja-2',
       'sbmotos',
       'gmr'
     );

  if target_accounts <> 4 then
    raise exception 'reparo de contas ML recusado: esperava 4 contas de destino, encontrou %', target_accounts;
  end if;

  select count(*)
    into source_links
    from public.sku_listing_links
   where ml_account_id in (
     select id
       from public.ml_accounts
      where organization_id = target_organization_id
        and slug in (
          'ml-speedbikers-loja-1',
          'ml-speedbikers-loja-2',
          'ml-sbmotos',
          'ml-gmr'
        )
   );

  if source_links <> 20650 then
    raise exception 'reparo de contas ML recusado: esperava 20650 vínculos nos placeholders, encontrou %', source_links;
  end if;

  select count(*)
    into target_links
    from public.sku_listing_links
   where ml_account_id in (
     select id
       from public.ml_accounts
      where organization_id = target_organization_id
        and slug in (
          'speedbikers-loja-1',
          'speedbikers-loja-2',
          'sbmotos',
          'gmr'
        )
   );

  if target_links <> 0 then
    raise exception 'reparo de contas ML recusado: as contas de destino já têm % vínculos', target_links;
  end if;

  with source_ids as (
    select id
      from public.ml_accounts
     where organization_id = target_organization_id
       and slug in (
         'ml-speedbikers-loja-1',
         'ml-speedbikers-loja-2',
         'ml-sbmotos',
         'ml-gmr'
       )
  )
  select
    (select count(*) from public.link_candidates where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.ml_credentials where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.ml_oauth_states where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.user_account_permissions where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.sync_runs where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.sync_errors where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.domain_events where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.orders where ml_account_id in (select id from source_ids)) +
    (select count(*) from public.order_items where ml_account_id in (select id from source_ids))
    into unexpected_dependencies;

  if unexpected_dependencies <> 0 then
    raise exception 'reparo de contas ML recusado: placeholders ganharam % dependências além dos vínculos', unexpected_dependencies;
  end if;

  with account_pairs(source_slug, target_slug) as (
    values
      ('ml-speedbikers-loja-1', 'speedbikers-loja-1'),
      ('ml-speedbikers-loja-2', 'speedbikers-loja-2'),
      ('ml-sbmotos', 'sbmotos'),
      ('ml-gmr', 'gmr')
  )
  update public.sku_listing_links as listing_link
     set ml_account_id = target.id
    from account_pairs as pair
    join public.ml_accounts as source
      on source.organization_id = target_organization_id
     and source.slug = pair.source_slug
    join public.ml_accounts as target
      on target.organization_id = source.organization_id
     and target.slug = pair.target_slug
   where listing_link.ml_account_id = source.id;

  get diagnostics moved_links = row_count;

  if moved_links <> 20650 then
    raise exception 'reparo de contas ML recusado: esperava mover 20650 vínculos, moveu %', moved_links;
  end if;

  delete from public.ml_accounts
   where organization_id = target_organization_id
     and created_by_import = true
     and status = 'PENDING'
     and slug in (
       'ml-speedbikers-loja-1',
       'ml-speedbikers-loja-2',
       'ml-sbmotos',
       'ml-gmr'
     );

  get diagnostics removed_accounts = row_count;

  if removed_accounts <> 4 then
    raise exception 'reparo de contas ML recusado: esperava remover 4 placeholders, removeu %', removed_accounts;
  end if;
end;
$$;
