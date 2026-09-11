-- ============================================================
-- `get_link_integrity.com_vinculo` passa a usar a definicao de D-122 (D-313).
--
-- O DEFEITO, VISTO NA TELA. `/vinculacoes` voltou a mostrar a comparacao entre
-- contas (D-128, que o reenquadramento de D-259 tinha reduzido a um `reduce`),
-- e a tela passou a dizer DUAS COISAS sobre a mesma palavra: a faixa contava
-- 3 anuncios sem vinculo e a comparacao, logo abaixo, contava 4.
--
-- Nenhum dos dois numeros era arredondamento do outro: eram DEFINICOES
-- diferentes de "vinculado".
--
--   get_listings_dashboard   `l.sku_id is not null` -> 'linked'
--                            existe linha de variacao -> 'linked_variation'
--   get_link_integrity       SO existe linha em `sku_listing_links`
--
-- Ou seja: o vinculo DIRETO -- o `sku_id` gravado no proprio anuncio, que e a
-- forma mais comum -- nao contava aqui. A coluna chamada "com_vinculo" dizia
-- menos que a verdade desde D-128, e ninguem viu porque o unico consumidor
-- somava as linhas num total e descartava a granularidade.
--
-- MEDIDO no local, conta `e2e-loja`, 5 anuncios (1 direto, 1 por variacao):
--
--                        antes   depois
--   com_vinculo              1        2
--   sem_vinculo              4        3   <- agora igual a faixa
--   pct_vinculado          20%      40%
--
-- O `pct_vinculado` e derivado, entao ele se corrige junto -- e era ele que o
-- brief secao 26 mostrava. `vendidos_sem_vinculo` e `receita_sem_vinculo` NAO
-- mudam: essas contam a partir de `order_items` (fonte independente) e ja
-- usavam o proprio predicado, que e outro assunto.
--
-- ASSINATURA: identica (uuid, integer) -- nenhuma chamada muda, e os tipos
-- gerados continuam validos. Consumidor unico, conferido antes de escrever:
-- `apps/web/app/vinculacoes/page.tsx`; nenhuma funcao SQL a chama.
--
-- O corpo abaixo foi EXTRAIDO DO ARQUIVO da migration que criou a funcao
-- (`20260828193942_create_link_integrity_rpc.sql`) e nao transcrito a mao; a
-- unica alteracao e o `filter` acima.
-- ============================================================

drop function public.get_link_integrity(uuid, integer);

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
           -- D-313: `l.sku_id is not null` ENTROU. Sem ele esta coluna so
           -- conhecia o vinculo gravado em `sku_listing_links`, e o vinculo
           -- direto (a coluna `sku_id` do proprio anuncio) contava como SEM
           -- VINCULO -- a mesma palavra com duas definicoes na mesma tela.
           count(*) filter (where l.sku_id is not null or exists (
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
  'Integridade de vinculacao por conta (D-128). "com_vinculo" usa a definicao de D-122 desde D-313: vinculo DIRETO (listings.sku_id) OU linha em sku_listing_links -- a mesma que get_listings_dashboard usa, para a comparacao entre contas nao discordar da faixa de KPIs. A coluna decisiva continua sendo vendidos_sem_vinculo: vem das VENDAS, fonte independente do pipeline de vinculacao e do de catalogo.';

revoke all on function public.get_link_integrity(uuid, integer) from public, anon;
grant execute on function public.get_link_integrity(uuid, integer) to authenticated;
