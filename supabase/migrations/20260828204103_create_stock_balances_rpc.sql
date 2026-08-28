-- O saldo por SKU passa a sair pivotado e ordenado do Postgres (D-131).
--
-- O defeito medido em `apps/web/app/estoque/page.tsx`: a tela lia
-- `inventory_balances` com `.order("quantity", { ascending: false })` e SEM
-- `.range()`. Com 2.524 linhas e teto de 1.000, o `order by` nao servia para
-- exibir nada -- a tela reordenava por SKU em JavaScript logo depois. Ele so
-- decidia QUAIS 1.000 linhas sobreviviam ao corte, e pelo pior criterio
-- possivel: as maiores quantidades primeiro. Resultado medido: das 1.645
-- linhas com saldo negativo, cerca de 1.524 ficavam invisiveis, enquanto os
-- saldos inflados por D-131/D-132 ocupavam a tela inteira.
--
-- O pivo LOCAL/RESERVADO/TRANSITO tambem era montado em JavaScript com um
-- `Map`, o que `docs/ARCHITECTURE.md` secao 15/21 proibe -- e que, sobre
-- resultado truncado, produz linha incompleta em silencio: um SKU cuja linha
-- RESERVADO caisse fora do corte apareceria com reservado zero.

create function public.get_stock_balances(
  p_organization_id uuid
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  local_quantity numeric,
  reservado numeric,
  transito numeric,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pivot as (
    select
      b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL') as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO') as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
    group by b.sku_id
  )
  select
    p.sku_id,
    sk.sku,
    sk.title,
    coalesce(p.local_quantity, 0) as local_quantity,
    coalesce(p.reservado, 0) as reservado,
    coalesce(p.transito, 0) as transito,
    count(*) over () as total_count
  from pivot p
  join public.skus sk on sk.id = p.sku_id
  order by sk.sku
$$;

comment on function public.get_stock_balances is
  'Saldo por SKU ja pivotado em LOCAL/RESERVADO/TRANSITO e ordenado por SKU (D-131). Substitui o pivo em JavaScript de /estoque, que era montado sobre um resultado truncado em 1.000 de 2.524 linhas -- e cuja ordenacao por quantidade decidia o corte, escondendo ~1.524 saldos negativos. `total_count` e janela sobre o conjunto inteiro, para a tela saber quanto ficou de fora da pagina.';

revoke all on function public.get_stock_balances(uuid) from public, anon;
grant execute on function public.get_stock_balances(uuid) to authenticated, service_role;
