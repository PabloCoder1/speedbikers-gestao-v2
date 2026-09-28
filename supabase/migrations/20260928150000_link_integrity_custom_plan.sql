-- ============================================================
-- `get_link_integrity` passa a `plpgsql` + `force_custom_plan` (auditoria de
-- 2026-09-28), o mesmo remedio de D-305 para `get_listings_dashboard`.
--
-- O SINTOMA. No `pg_stat_statements` de producao (18 a 28/09) a funcao chegou
-- a 7.540 ms, a 0,46 s do `statement_timeout` de 8 s do papel `authenticated`,
-- lendo ~73 MB do disco por chamada. `/vinculacoes` a le dentro de `Suspense`,
-- entao o estouro some da tela como "conferencia indisponivel".
--
-- A CAUSA, medida no Dev como `authenticated` (organizacao de 5.093 anuncios e
-- 68 mil pedidos em 90 dias):
--
--                                           tempo
--   get_link_integrity(org, 90)          7.256 ms  (temp: 452 blocos escritos)
--   o mesmo corpo, com a org LITERAL       456 ms  (catalogo 18 + vendas 438)
--
-- Funcao `language sql` com `set search_path` nunca e inlined: o corpo e
-- planejado sem o valor de `p_organization_id`, e o plano generico erra. Em
-- plpgsql o `return query` passa pelo SPI, e `force_custom_plan` impede a
-- volta ao generico na sexta execucao.
--
-- ENSAIO no Dev, em `begin ... rollback`, como `authenticated`, sete execucoes
-- seguidas: 703, 387, 716, 711, 394, 380 e 375 ms (a sexta e a setima
-- continuam rapidas: o generico nao voltou). As 4 linhas saem identicas as da
-- versao `sql` (`except` vazio).
--
-- O QUE NAO MUDOU: assinatura (uuid, integer), colunas de saida, `stable`,
-- `security invoker`, `search_path = ''` e o SQL do corpo, EXTRAIDO do arquivo
-- `20260911180000_link_integrity_com_vinculo_d122.sql` por script, nao
-- transcrito. Nenhuma coluna de saida e referenciada sem qualificacao no corpo
-- (a colisao que D-305 teve de corrigir em `link_state`), entao nada mais
-- mudou. `create or replace` mantem grants e comentario.
-- ============================================================

create or replace function public.get_link_integrity(
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
language plpgsql
stable
security invoker
set search_path = ''
-- A linha que impede a volta do plano generico (D-305).
set plan_cache_mode = 'force_custom_plan'
as $fn$
begin
  return query
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
  order by c.label;
end;
$fn$;
