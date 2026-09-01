-- ============================================================
-- As marcas do filtro deixam de ser deduzidas em JavaScript (D-194).
--
-- MEDIDO no Dev em 2026-09-01:
--
--   marcas que existem de verdade ......... 19
--   marcas que a tela conseguia mostrar .... 9
--   linhas trafegadas para produzir isso ... 3.550
--
-- Tres telas (`/estoque`, `/reposicao`, `/reposicao/configuracoes`) liam
-- `skus.supplier_brand` de TODAS as linhas e deduziam as distintas com
-- `new Set(...)`. Sao dois defeitos no mesmo lugar:
--
-- **1. O corte de 1.000 do PostgREST (D-131).** Sao 3.550 linhas, a consulta
-- volta com 1.000, e `error` e NULO — o codigo segue achando que viu tudo.
-- Como a ordenacao e por `supplier_brand`, o que sobrevive sao as marcas
-- alfabeticamente primeiras: **10 das 19 simplesmente nao aparecem no
-- filtro**. Nao e detalhe de estilo; e a tela mostrando menos da metade das
-- opcoes, sem avisar.
--
-- **2. Agregacao em JavaScript**, que `docs/ARCHITECTURE.md` (secao 15/21)
-- proibe. `distinct` e trabalho de banco: 19 valores atravessam a rede em vez
-- de 3.550 linhas.
--
-- Paginar com `readAllPages` (D-131) resolveria (1) e nao (2) — e seria
-- trazer 3.550 linhas para contar 19. A correcao certa e a agregacao ir para
-- onde ela pertence.
-- ============================================================

create function public.get_supplier_brands(p_organization_id uuid)
returns table (supplier_brand text)
language sql
stable
security invoker
set search_path = ''
as $$
  -- SECURITY INVOKER de proposito: a RLS de `skus` ja restringe a
  -- organizacao do chamador, e o parametro serve ao indice, nao a
  -- autorizacao. Uma DEFINER aqui atravessaria a RLS sem necessidade —
  -- a superficie exposta e versionada em teste (D-182), e nao ha razao
  -- para aumenta-la por uma lista de 19 strings.
  select distinct s.supplier_brand
  from public.skus s
  where s.organization_id = p_organization_id
    and s.supplier_brand is not null
  order by s.supplier_brand;
$$;

comment on function public.get_supplier_brands(uuid) is
  'Marcas distintas do catalogo, para o filtro das telas de estoque e reposicao (D-194). Existe porque a forma anterior lia 3.550 linhas para deduzir 19 valores em JavaScript — e o teto de 1.000 do PostgREST fazia 10 das 19 marcas nunca aparecerem.';

revoke all on function public.get_supplier_brands(uuid) from public, anon;
grant execute on function public.get_supplier_brands(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- A prova
-- ------------------------------------------------------------
do $$
declare
  n integer;
begin
  -- Continua SECURITY INVOKER: se virar DEFINER, entra na lista de superficie
  -- exposta e o teste de D-182 falha — melhor falhar aqui, com a razao junto.
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'get_supplier_brands' and p.prosecdef
  ) then
    raise exception 'D-194: get_supplier_brands nao pode ser SECURITY DEFINER';
  end if;

  -- E inalcancavel por quem nao esta autenticado.
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'get_supplier_brands'
    and has_function_privilege('anon', p.oid, 'execute');

  if n > 0 then
    raise exception 'D-194: get_supplier_brands alcancavel por anon';
  end if;
end $$;
