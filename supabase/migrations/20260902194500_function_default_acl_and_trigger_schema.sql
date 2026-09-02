-- ============================================================
-- Fecha a torneira que D-182 deixou aberta: o default de FUNCOES.
--
-- D-182 fechou "postgres/tabelas" e "postgres/sequences" e registrou o resto
-- por escrito: "postgres/funcoes -- deixado. As RPCs dependem de grant
-- execute; exige varrer todas as migrations que criam funcao". Esta e a
-- varredura, e ela mudou o que o item parecia ser.
--
-- O QUE FOI MEDIDO, NOS DOIS BANCOS -- e os dois PRECISAM ser consultados,
-- porque discordam:
--
--   pg_default_acl, grantor postgres, schema public, FUNCOES
--     Dev   : {postgres=X, anon=X, authenticated=X, service_role=X}
--     local : {postgres=X}
--
-- No Dev, TODA funcao nova de public nasce executavel por anon. Localmente,
-- nao. O repositorio nao controla nenhum dos dois: o valor vem do bootstrap
-- da plataforma, e as versoes divergiram.
--
-- A EXPOSICAO DE HOJE E IDENTICA NOS DOIS, E NAO E EXPLORAVEL. Medido com
-- has_function_privilege, que resolve PUBLIC -- contar ACL crua da a resposta
-- errada, e deu 58 contra 64:
--
--     funcoes em public ............... Dev 70 | local 70
--     executaveis por anon ............ Dev  6 | local  6
--     ... e que NAO sao de trigger .... Dev  0 | local  0
--
-- As 6 sao funcoes de trigger, e o Postgres recusa chamada direta delas --
-- conferido como anon: o privilegio existe (has_function_privilege = true) e a
-- chamada morre em "trigger functions can only be called as triggers".
--
-- ENTAO O DEFEITO NAO E A EXPOSICAO ATUAL: E A PROXIMA FUNCAO. No Dev ela
-- nasce com anon; no local, nao. Um esquecimento de "revoke ... from anon"
-- passaria verde na CI e no banco local e viveria so no Dev -- a classe de
-- D-204/D-207, em que o repositorio deixa de ser a autoridade e os ambientes
-- divergem em silencio.
--
-- POR QUE FECHAR TAMBEM PARA authenticated, e nao so para anon: e uma troca
-- deliberada de modo de falha. Hoje, esquecer o revoke produz uma funcao
-- silenciosamente chamavel por quem nao fez login -- falha SILENCIOSA e de
-- seguranca. Depois, esquecer o grant produz uma funcao que nao roda para
-- ninguem -- falha RUIDOSA e funcional, que o teste da propria fatia pega. O
-- habito ja existe: as migrations escrevem 77 "grant execute on function"
-- explicitos, em 60 arquivos.
--
-- service_role fica de fora de proposito: e o papel do backend (api/worker),
-- nao alcanca o navegador, e revoga-lo trocaria um risco inexistente por
-- quebra real.
--
-- ------------------------------------------------------------
-- E as 6 funcoes de trigger saem de public, que e o motivo de elas serem as
-- unicas alcancaveis por anon.
--
-- Nao e limpeza oportunista: e a regra que a propria casa escreveu em
-- 20260820160000, ao mover job_runs_reject_mutation para private -- "public e
-- o schema exposto pelo PostgREST e deve conter tabelas, nao maquinaria
-- interna". 18 funcoes de trigger ja moram em private; estas 6 sao as
-- retardatarias. Movidas, o numero de funcoes de public alcancaveis por anon
-- vai a ZERO por ESTRUTURA, nao por grant.
--
-- As mensagens de excecao sao reproduzidas ao pe da letra: ha testes que as
-- afirmam.
-- ============================================================

-- ------------------------------------------------------------
-- 1. As 6 funcoes passam a morar em private
-- ------------------------------------------------------------
create or replace function private.domain_events_reject_mutation()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception
    'domain_events e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$fn$;

create or replace function private.listing_relist_events_reject_mutation()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'listing_relist_events e append-only: % nao e permitido.', tg_op;
end;
$fn$;

create or replace function private.purchase_order_events_reject_mutation()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'purchase_order_events e append-only: % nao e permitido.', tg_op;
end;
$fn$;

create or replace function private.stock_movements_reject_mutation()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception
    'stock_movements e append-only: % nao e permitido. Corrija inserindo uma nova linha (ex.: AJUSTE_MANUAL).',
    tg_op;
end;
$fn$;

create or replace function private.sync_errors_reject_mutation()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception
    'sync_errors e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$fn$;

create or replace function private.sync_runs_reject_mutation()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception
    'sync_runs e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$fn$;

-- ------------------------------------------------------------
-- 2. Os 12 triggers passam a apontar para private, e as funcoes de public
--    somem. Mesma sequencia de 20260820160000.
-- ------------------------------------------------------------
drop trigger if exists domain_events_no_update on public.domain_events;
drop trigger if exists domain_events_no_delete on public.domain_events;
create trigger domain_events_no_update before update on public.domain_events
  for each row execute function private.domain_events_reject_mutation();
create trigger domain_events_no_delete before delete on public.domain_events
  for each row execute function private.domain_events_reject_mutation();
drop function if exists public.domain_events_reject_mutation();

drop trigger if exists listing_relist_events_no_update on public.listing_relist_events;
drop trigger if exists listing_relist_events_no_delete on public.listing_relist_events;
create trigger listing_relist_events_no_update before update on public.listing_relist_events
  for each row execute function private.listing_relist_events_reject_mutation();
create trigger listing_relist_events_no_delete before delete on public.listing_relist_events
  for each row execute function private.listing_relist_events_reject_mutation();
drop function if exists public.listing_relist_events_reject_mutation();

drop trigger if exists purchase_order_events_no_update on public.purchase_order_events;
drop trigger if exists purchase_order_events_no_delete on public.purchase_order_events;
create trigger purchase_order_events_no_update before update on public.purchase_order_events
  for each row execute function private.purchase_order_events_reject_mutation();
create trigger purchase_order_events_no_delete before delete on public.purchase_order_events
  for each row execute function private.purchase_order_events_reject_mutation();
drop function if exists public.purchase_order_events_reject_mutation();

drop trigger if exists stock_movements_no_update on public.stock_movements;
drop trigger if exists stock_movements_no_delete on public.stock_movements;
create trigger stock_movements_no_update before update on public.stock_movements
  for each row execute function private.stock_movements_reject_mutation();
create trigger stock_movements_no_delete before delete on public.stock_movements
  for each row execute function private.stock_movements_reject_mutation();
drop function if exists public.stock_movements_reject_mutation();

drop trigger if exists sync_errors_no_update on public.sync_errors;
drop trigger if exists sync_errors_no_delete on public.sync_errors;
create trigger sync_errors_no_update before update on public.sync_errors
  for each row execute function private.sync_errors_reject_mutation();
create trigger sync_errors_no_delete before delete on public.sync_errors
  for each row execute function private.sync_errors_reject_mutation();
drop function if exists public.sync_errors_reject_mutation();

drop trigger if exists sync_runs_no_update on public.sync_runs;
drop trigger if exists sync_runs_no_delete on public.sync_runs;
create trigger sync_runs_no_update before update on public.sync_runs
  for each row execute function private.sync_runs_reject_mutation();
create trigger sync_runs_no_delete before delete on public.sync_runs
  for each row execute function private.sync_runs_reject_mutation();
drop function if exists public.sync_runs_reject_mutation();

-- ------------------------------------------------------------
-- 3. A torneira
-- ------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. As provas, dentro da propria migration (padrao de D-182 secao 6).
--    Elas afirmam o ESTADO ALCANCADO -- nao consultam catalogo para DECIDIR
--    o que fazer, que e a armadilha de D-204.
-- ------------------------------------------------------------
do $prova$
declare
  n integer;
begin
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prorettype::regtype::text = 'trigger';

  if n <> 0 then
    raise exception 'ainda ha % funcao(oes) de trigger em public', n;
  end if;

  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');

  if n <> 0 then
    raise exception '% funcao(oes) de public continuam alcancaveis por anon', n;
  end if;

  select count(*) into n
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace ns on ns.oid = p.pronamespace
  where not t.tgisinternal and ns.nspname = 'private'
    and p.proname like '%_reject_mutation';

  if n < 14 then
    raise exception 'esperava ao menos 14 triggers append-only em private, achei %', n;
  end if;
end;
$prova$;

-- ------------------------------------------------------------
-- 5. A prova que so o Dev pode dar.
--
-- O guarda de CI equivalente PASSA no banco local mesmo sem esta migration,
-- porque o bootstrap local ja nascia fechado -- ele nao consegue reprovar o
-- estado que existe no Dev. Esta asserçao roda no ATO da aplicacao, nos dois
-- bancos, e e o unico ponto em que o estado do Dev e conferido de verdade.
-- ------------------------------------------------------------
do $torneira$
declare
  abertos text;
begin
  select string_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, ', ')
    into abertos
  from pg_default_acl d
  join pg_namespace ns on ns.oid = d.defaclnamespace,
  lateral aclexplode(d.defaclacl) a
  where ns.nspname = 'public'
    and d.defaclobjtype = 'f'
    and pg_get_userbyid(d.defaclrole) = 'postgres'
    and a.privilege_type = 'EXECUTE'
    and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'));

  if abertos is not null then
    raise exception 'o default de funcoes ainda concede EXECUTE a: %', abertos;
  end if;
end;
$torneira$;
