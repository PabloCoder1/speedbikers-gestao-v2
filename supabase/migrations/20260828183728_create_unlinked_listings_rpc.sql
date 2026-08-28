-- Fila real da Central de Vinculações: anúncios do catálogo que não têm
-- vínculo em NENHUMA forma (D-122).
--
-- A armadilha que esta função existe para evitar: `listings.sku_id IS NULL`
-- NÃO significa "anúncio sem vínculo". O lookup que preenche essa coluna
-- (`ml-listings-fetch.ts`) usa `ref_kind='ITEM'` e `variation_id IS NULL`, de
-- propósito — a pergunta do SYNC é "que SKU atribuo a ESTE item?". Um anúncio
-- corretamente vinculado nas suas VARIAÇÕES chega com `sku_id` nulo.
--
-- Medido em 2026-08-28: dos 1.917 com `sku_id` nulo, **1.013 (52,8%) já têm
-- vínculo de variação**. Sem o anti-join, mais da metade da fila seria
-- trabalho falso — e a ação natural do operador (vincular o anúncio inteiro)
-- é exatamente o estado misto que D-119 recusa: não resolve venda nenhuma e
-- ainda leva o estoque Full para o SKU errado.
--
-- A TELA pergunta "falta vínculo em qualquer forma?"; o SYNC pergunta "que SKU
-- atribuo a este item?". A divergência é intencional — não "corrigir" uma das
-- duas em nome da outra.
--
-- Em SQL e não em JavaScript por regra do projeto (`docs/ARCHITECTURE.md`
-- secao 15/21, "Zero agregação em JavaScript"): fazer o anti-join no servidor
-- de aplicação exigiria trafegar ~13 mil vínculos de variação por render.
--
-- `security invoker`: a RLS de `listings`/`sku_listing_links` decide o escopo
-- por chamador, mesmo padrão de `get_listing_sales`/`get_stock_coverage`.

create function public.get_unlinked_listings(
  p_organization_id uuid,
  p_status text default 'active',
  p_days integer default 30,
  p_limit integer default 100
)
returns table (
  ml_account_id uuid,
  account_label text,
  item_id text,
  title text,
  status text,
  price numeric,
  available_quantity integer,
  synced_at timestamptz,
  units_sold bigint,
  gross_revenue numeric,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with sem_vinculo as (
    select l.ml_account_id, l.item_id, l.title, l.status, l.price,
           l.available_quantity, l.synced_at
    from public.listings l
    where l.organization_id = p_organization_id
      and (p_status is null or l.status = p_status)
      -- Anti-join por QUALQUER forma de vínculo do mesmo item.
      and not exists (
        select 1
        from public.sku_listing_links k
        where k.ml_account_id = l.ml_account_id
          and k.item_id = l.item_id
      )
  ),
  vendas as (
    select m.ml_account_id, m.mlb_id,
           sum(m.units_sold) as units_sold,
           sum(m.gross_revenue) as gross_revenue
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date >= (current_date - p_days)
    group by m.ml_account_id, m.mlb_id
  )
  select s.ml_account_id,
         a.label as account_label,
         s.item_id,
         s.title,
         s.status,
         s.price,
         s.available_quantity,
         s.synced_at,
         coalesce(v.units_sold, 0)::bigint as units_sold,
         coalesce(v.gross_revenue, 0)::numeric as gross_revenue,
         count(*) over () as total_count
  from sem_vinculo s
  join public.ml_accounts a on a.id = s.ml_account_id
  left join vendas v on v.ml_account_id = s.ml_account_id and v.mlb_id = s.item_id
  -- Ordem por DINHEIRO, não por data: a fila tem centenas de linhas e o que
  -- importa é o anúncio que vende sem estar vinculado.
  order by coalesce(v.gross_revenue, 0) desc, s.item_id
  limit p_limit;
$$;

comment on function public.get_unlinked_listings is
  'Anuncios do catalogo sem vinculo em NENHUMA forma (D-122). listings.sku_id IS NULL nao serve: ignora vinculos de variacao.';

revoke all on function public.get_unlinked_listings(uuid, text, integer, integer) from anon;
grant execute on function public.get_unlinked_listings(uuid, text, integer, integer) to authenticated;
