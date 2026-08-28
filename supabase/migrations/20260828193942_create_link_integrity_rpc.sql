-- Integridade de vinculações por conta (D-128), requisito do usuário
-- (blocos 16 e 17): a Central de Vinculações não pode ser acreditada pela
-- própria fila.
--
-- A regra que este RPC existe para cumprir: "NÃO assumir que
-- `link_candidates OPEN = 0` significa que todos os anúncios estão
-- vinculados". D-117 provou que era exatamente o que acontecia — a tabela
-- está vazia desde sempre e era estruturalmente incapaz de receber anúncio
-- do Mercado Livre.
--
-- Por isso a coluna que importa aqui é a ÚLTIMA: `vendidos_sem_vinculo` não
-- vem do pipeline de vinculação nem do de catálogo. Vem das VENDAS — um item
-- que gerou pedido existe, independentemente do que qualquer varredura nossa
-- ache. É a reconciliação independente: se ela e a fila discordarem, o
-- problema está no pipeline, não no número.

create function public.get_link_integrity(
  p_organization_id uuid,
  p_days integer default 90
)
returns table (
  ml_account_id uuid,
  account_label text,
  listings_total bigint,
  listings_ativos bigint,
  com_vinculo bigint,
  sem_vinculo bigint,
  pct_vinculado numeric,
  candidatos_abertos bigint,
  vendidos_no_periodo bigint,
  vendidos_sem_vinculo bigint,
  receita_sem_vinculo numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with contas as (
    select a.id, a.label
    from public.ml_accounts a
    where a.organization_id = p_organization_id
  ),
  catalogo as (
    select l.ml_account_id,
           count(*) as total,
           count(*) filter (where l.status = 'active') as ativos,
           count(*) filter (where exists (
             select 1 from public.sku_listing_links k
             where k.ml_account_id = l.ml_account_id and k.item_id = l.item_id
           )) as com_vinculo
    from public.listings l
    where l.organization_id = p_organization_id
    group by l.ml_account_id
  ),
  candidatos as (
    select c.ml_account_id, count(*) as abertos
    from public.link_candidates c
    where c.organization_id = p_organization_id and c.status = 'OPEN'
    group by c.ml_account_id
  ),
  -- Fonte INDEPENDENTE: item que vendeu existe, quer a varredura o conheça
  -- ou não. É o único número desta tela que não depende do pipeline auditado.
  vendas as (
    select o.ml_account_id,
           count(distinct oi.item_id) as itens,
           count(distinct oi.item_id) filter (where not exists (
             select 1 from public.sku_listing_links k
             where k.ml_account_id = o.ml_account_id and k.item_id = oi.item_id
           )) as itens_sem_vinculo,
           sum(oi.unit_price * oi.quantity) filter (where not exists (
             select 1 from public.sku_listing_links k
             where k.ml_account_id = o.ml_account_id and k.item_id = oi.item_id
           )) as receita_sem_vinculo
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.organization_id = p_organization_id
      and o.status in ('paid', 'partially_refunded')
      and o.date_created >= (now() - make_interval(days => p_days))
      and oi.item_id is not null
    group by o.ml_account_id
  )
  select
    c.id,
    c.label,
    coalesce(cat.total, 0)::bigint,
    coalesce(cat.ativos, 0)::bigint,
    coalesce(cat.com_vinculo, 0)::bigint,
    (coalesce(cat.total, 0) - coalesce(cat.com_vinculo, 0))::bigint,
    case
      when coalesce(cat.total, 0) = 0 then null
      else round(100.0 * coalesce(cat.com_vinculo, 0) / cat.total, 1)
    end,
    coalesce(cand.abertos, 0)::bigint,
    coalesce(v.itens, 0)::bigint,
    coalesce(v.itens_sem_vinculo, 0)::bigint,
    coalesce(v.receita_sem_vinculo, 0)::numeric
  from contas c
  left join catalogo cat on cat.ml_account_id = c.id
  left join candidatos cand on cand.ml_account_id = c.id
  left join vendas v on v.ml_account_id = c.id
  order by c.label
$$;

comment on function public.get_link_integrity is
  'Integridade de vinculacao por conta (D-128). A coluna decisiva e vendidos_sem_vinculo: vem das VENDAS, fonte independente do pipeline de vinculacao e do de catalogo. Se ela discordar da fila de candidatos, o problema esta no pipeline.';

revoke all on function public.get_link_integrity(uuid, integer) from public, anon;
grant execute on function public.get_link_integrity(uuid, integer) to authenticated;
