-- ============================================================
-- P0-E: o inventario da superficie de autorizacao, e as duas
-- validacoes de escopo que a auditoria encontrou (D-182).
--
-- O P0-E pedia inventario de SECURITY DEFINER, search_path e policies
-- permissivas duplicadas. O inventario foi feito e o resultado e que **nao
-- havia vulnerabilidade nenhuma nesses tres itens**:
--
--   * SECURITY DEFINER sem search_path: ZERO (nos dois schemas).
--   * Policies duplicadas: existem 4, e nas 4 o predicado da policy `ALL` e
--     SUBCONJUNTO do predicado de SELECT — redundancia, nao vazamento. O
--     custo tambem e zero: a funcao so seria avaliada nas linhas que a
--     policy de SELECT ja rejeitou.
--   * search_path mutavel: 7 funcoes, todas de trigger, cujo corpo inteiro e
--     um `raise exception` sem UM identificador resolvivel.
--
-- O que a auditoria encontrou de verdade foi outra coisa, no caminho: duas
-- funcoes que aceitam uma FK do cliente sem validar a organizacao dela.
-- Sao latentes hoje (uma organizacao, um membro) e mordem no dia da segunda
-- — a mesma classe de D-180.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O SKU de outra organizacao entrando num pedido de compra
--
-- `create_purchase_order` e `update_purchase_order_draft` validam o
-- FORNECEDOR contra a organizacao e depois inserem `sku_id` cru do JSON do
-- cliente. A funcao irma `create_manual_stock_adjustment` JA faz a checagem,
-- com esta mensagem exata — entao isto e inconsistencia, nao escolha.
--
-- Por que TRIGGER e nao uma checagem dentro das duas funcoes: repetir a
-- validacao em cada escritor foi exatamente o que falhou aqui. Ha tres
-- funcoes que propagam esses itens para `stock_movements`
-- (`mark_purchase_order_ordered`, `receive_purchase_order`,
-- `cancel_purchase_order`) e nenhuma delas revalida. Um invariante na tabela
-- vale para as tres e para a quarta que alguem escrever depois.
--
-- O dano que isto evita nao e a quantidade lancada — `receive`/`cancel`
-- lancam o contra-movimento. E a LINHA CARIMBADA: `inventory_balances` tem
-- `unique (sku_id, location_kind)` SEM organizacao, entao o upsert de A
-- criaria a linha de saldo de um SKU de B carimbada com a organizacao A, e a
-- policy de leitura esconderia de B o proprio saldo, para sempre.
create function private.purchase_order_item_org_matches_sku()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- `sku_id` e nullable de proposito: item de texto livre, sem SKU
  -- cadastrado, e fluxo legitimo de pedido de compra.
  if new.sku_id is not null
     and (select k.organization_id from public.skus k where k.id = new.sku_id)
         is distinct from new.organization_id then
    raise exception 'SKU pertence a outra organizacao';
  end if;

  return new;
end;
$$;

comment on function private.purchase_order_item_org_matches_sku() is
  'Impede que um item de pedido de compra aponte para SKU de outra organizacao (D-182). `is distinct from` tambem rejeita SKU inexistente, porque o subselect devolve NULL.';

create trigger purchase_order_items_org_matches_sku
  before insert or update on public.purchase_order_items
  for each row execute function private.purchase_order_item_org_matches_sku();

-- ------------------------------------------------------------
-- 2. O responsavel de outra organizacao numa acao
--
-- `update_action_status` confere que QUEM CHAMA e membro da organizacao da
-- acao, mas nao confere nada sobre `p_assignee_id` — que e uma FK escolhida
-- pelo cliente. `triage_support_case` valida a mesma coluna e explica por
-- que; aqui faltou.
--
-- Recriada por inteiro (o corpo abaixo e o que estava no banco, com o bloco
-- novo inserido antes do update) — `create or replace` de funcao nao aceita
-- remendo parcial.
create or replace function public.update_action_status(
  p_id uuid,
  p_status text,
  p_assignee_id uuid default null::uuid
)
returns public.actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.actions;
  result public.actions;
begin
  select * into a from public.actions where id = p_id;

  if a.id is null then
    raise exception 'ação % não encontrada', p_id;
  end if;

  if not private.is_member_of(a.organization_id) then
    raise exception 'sem permissao para atualizar esta ação';
  end if;

  if p_status not in ('novo', 'em_andamento', 'resolvido', 'descartado') then
    raise exception 'status invalido: %', p_status;
  end if;

  -- D-182: o responsavel tem de ser da MESMA organizacao da acao. Sem isto,
  -- um membro de A atribui uma acao de A a alguem de B — o efeito visivel e
  -- pequeno hoje (a tela nao lista por responsavel), mas e uma FK cross-org
  -- gravada por uma SECURITY DEFINER, que e a forma como esse tipo de furo
  -- costuma virar vazamento depois.
  if p_assignee_id is not null and not exists (
    select 1
    from public.organization_members m
    where m.user_id = p_assignee_id
      and m.organization_id = a.organization_id
  ) then
    raise exception 'responsavel nao pertence a esta organizacao';
  end if;

  update public.actions set
    status = p_status,
    assignee_id = coalesce(p_assignee_id, assignee_id)
  where id = p_id
  returning * into result;

  return result;
end;
$$;

-- ------------------------------------------------------------
-- 3. Os 7 search_path mutaveis
--
-- HONESTIDADE: nao era vulnerabilidade. As sete sao funcoes de trigger cujo
-- corpo inteiro e `raise exception '<literal>', tg_op` — nenhum identificador
-- para um search_path hostil sequestrar, e o Postgres recusa chamada direta
-- de funcao de trigger ("trigger functions can only be called as triggers").
--
-- O que se ganha e o painel: 7 dos 33 WARN do advisor eram estes (o numero
-- foi conferido depois de aplicar; o comentario aplicado no Dev dizia 11, que
-- era contagem minha errada). Um painel
-- com ruido conhecido e um painel que ninguem le, e o proximo alerta — esse
-- real — se perde no meio.
--
-- `alter function ... set` nao reescreve o corpo nem muda o OID, entao os
-- triggers ligados por `pg_trigger.tgfoid` continuam validos.
alter function private.sku_cost_history_reject_mutation() set search_path = '';
alter function public.domain_events_reject_mutation() set search_path = '';
alter function public.listing_relist_events_reject_mutation() set search_path = '';
alter function public.purchase_order_events_reject_mutation() set search_path = '';
alter function public.stock_movements_reject_mutation() set search_path = '';
alter function public.sync_errors_reject_mutation() set search_path = '';
alter function public.sync_runs_reject_mutation() set search_path = '';

-- ------------------------------------------------------------
-- 4. O residuo inerte dos `grant all`
--
-- TRIGGER e REFERENCES para `authenticated` em 34 das 60 tabelas.
-- Nao ha caminho de exploracao: os dois so sao exercidos por DDL ou comando
-- utilitario, o PostgREST so emite SELECT/INSERT/UPDATE/DELETE e CALL, e
-- `authenticated` e dono de zero relacoes e tem CREATE em zero schemas.
-- Some pelo mesmo motivo do item 3: inventario so serve de guarda se for
-- absoluto. Uma lista de excecoes conhecidas e uma lista que ninguem revisa.
revoke trigger, references on all tables in schema public from authenticated;

-- As 6 sequences carregam `anon=rwU` NOMEADO, herdado de `pg_default_acl`.
-- Tambem inerte: as 6 colunas sao IDENTITY ALWAYS, e o Postgres avalia
-- IDENTITY por `NextValueExpr` sem consultar a ACL da sequence.
revoke all on all sequences in schema public from anon, authenticated;

-- ------------------------------------------------------------
-- 5. A porta por onde o residuo entra
--
-- `pg_default_acl` faz TODA tabela e sequence nova de `public` nascer com
-- privilegios para anon e authenticated. As tres rodadas de revoke
-- (D-066/D-098/D-130) limparam o que existia; isto fecha a torneira do lado
-- que importa.
--
-- ATENCAO AO ESCOPO — o que isto fecha e o que NAO fecha:
--
--   * fecha  `postgres` / tabelas e sequences. E o que importa: migration
--            roda como `postgres`, entao toda tabela nova da aplicacao nasce
--            por este caminho.
--   * deixa  `postgres` / funcoes. As RPCs dependem de `grant execute`, e a
--            interacao com o default exige varrer TODAS as migrations que
--            criam funcao — varredura que nao foi feita. Pendencia registrada.
--   * deixa  `supabase_admin` / tudo. Deliberado: e o papel da plataforma, nao
--            o nosso. Revogar dali pode quebrar maquinaria do proprio Supabase,
--            e o ganho seria zero — a aplicacao nao cria objeto por esse papel.
--
-- A guarda de verdade nao e esta migration, e o teste de CI
-- «nenhuma tabela de public da QUALQUER privilegio a anon», que pega o
-- vazamento independentemente de qual grantor o produziu.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- ------------------------------------------------------------
-- 6. As provas
-- ------------------------------------------------------------
do $$
declare
  n integer;
begin
  -- 6.1 nenhuma funcao de public/private com search_path mutavel
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname in ('public', 'private')
    and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%';
  if n > 0 then
    raise exception 'D-182: % funcoes ainda com search_path mutavel', n;
  end if;

  -- 6.2 o trigger de escopo do item de compra existe e esta ativo
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'purchase_order_items'
      and t.tgname = 'purchase_order_items_org_matches_sku'
      and not t.tgisinternal and t.tgenabled = 'O'
  ) then
    raise exception 'D-182: trigger de escopo do item de compra ausente ou desativado';
  end if;

  -- 6.3 update_action_status passou a validar o responsavel
  if (select pg_get_functiondef(p.oid) from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = 'update_action_status')
     not like '%responsavel nao pertence%' then
    raise exception 'D-182: update_action_status nao valida a organizacao do responsavel';
  end if;

  -- 6.4 nenhuma sequence de public alcancavel por anon
  --
  -- `as materialized` nao e estilo: sem a barreira, o Postgres avalia
  -- `has_sequence_privilege` ANTES do filtro `relkind='S'` (a ordem dos
  -- quals nao e garantida) e o bloco morre com «"suppliers" is not a
  -- sequence» em vez de falhar limpo. Foi o que aconteceu no ensaio desta
  -- migration — e e a mesma armadilha ja registrada em D-130.
  with seqs as materialized (
    select c.oid as oid
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'S'
  )
  select count(*) into n from seqs where has_sequence_privilege('anon', seqs.oid, 'USAGE');
  if n > 0 then
    raise exception 'D-182: % sequences ainda alcancaveis por anon', n;
  end if;

  -- 6.5 nenhuma tabela de public com QUALQUER privilegio para anon
  with tabelas as materialized (
    select c.oid as oid
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r'
  )
  select count(*) into n from tabelas
  where has_table_privilege('anon', tabelas.oid, 'SELECT')
     or has_table_privilege('anon', tabelas.oid, 'INSERT')
     or has_table_privilege('anon', tabelas.oid, 'UPDATE')
     or has_table_privilege('anon', tabelas.oid, 'DELETE')
     or has_table_privilege('anon', tabelas.oid, 'TRUNCATE')
     or has_table_privilege('anon', tabelas.oid, 'REFERENCES')
     or has_table_privilege('anon', tabelas.oid, 'TRIGGER');
  if n > 0 then
    raise exception 'D-182: % tabelas ainda com privilegio para anon', n;
  end if;

  -- 6.6 a superficie SECURITY DEFINER exposta nao cresceu
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'execute');
  if n <> 25 then
    raise exception 'D-182: % RPCs SECURITY DEFINER expostas, esperava 25', n;
  end if;
end $$;
