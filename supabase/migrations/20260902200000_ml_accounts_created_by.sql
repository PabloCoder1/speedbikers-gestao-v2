-- ============================================================
-- ml_accounts ganha AUTOR (item 10 do HANDOFF, nomeado em D-210).
--
-- D-210 encolheu a superficie de escrita do navegador em ml_accounts para um
-- unico verbo: INSERT. Com isso, a clausula "sem trilha de auditoria" do item
-- original se dissolveu -- as tabelas irmas tem trigger de auditoria porque
-- humanos mudam PRIVILEGIO nelas pela UI, e aqui nao ha mais mudanca de
-- privilegio para registrar. Sobrou uma ausencia menor e nomeavel: a tabela
-- tem created_at e nao tem quem.
--
-- POR QUE UM TRIGGER, E NAO UM `default auth.uid()`:
-- um default so vale quando a coluna e OMITIDA. Quem escreve direto no
-- PostgREST pode mandar created_by de outra pessoa, e a coluna deixaria de
-- ser um fato de auditoria para virar uma alegacao do cliente. O trigger
-- IGNORA o que veio e grava auth.uid(), que e o padrao que D-175 ja usa para
-- actor_user_id em organization_access_events.
--
-- NULO E DECLARACAO, NAO OMISSAO: escrita por service_role (api no OAuth,
-- seed, importacao do UpSeller) nao tem humano identificado, e auth.uid() e
-- nulo ali. Inventar um ator seria pior que declarar a ausencia -- mesma
-- regra, com as mesmas palavras, de D-175.
--
-- SEM BACKFILL: as contas que ja existem ficam com autor nulo. O historico
-- comeca aqui; carimbar o passado com quem "provavelmente" criou seria dado
-- inventado (D-175).
--
-- `on delete restrict` no perfil: mesma escolha de D-099 para coluna de ator
-- -- apagar o perfil nao pode apagar a autoria em silencio.
-- ============================================================

alter table public.ml_accounts
  add column created_by uuid references public.profiles(id) on delete restrict;

comment on column public.ml_accounts.created_by is
  'Quem criou a conta, gravado pelo trigger a partir de auth.uid() e NUNCA do que o cliente enviou. NULO quando a criacao veio de service_role (OAuth pela api, seed, importacao) ou e anterior a esta migration: sem humano identificado, declara-se a ausencia em vez de inventar um.';

create or replace function private.stamp_ml_account_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- Sobrescreve incondicionalmente: o valor que o cliente mandou nao e
  -- consultado, entao nao ha como forjar autoria.
  new.created_by := (select auth.uid());
  return new;
end;
$fn$;

comment on function private.stamp_ml_account_creator is
  'Carimba ml_accounts.created_by com auth.uid() no INSERT, ignorando o valor enviado pelo cliente. Nulo para service_role, por desenho.';

drop trigger if exists ml_accounts_stamp_creator on public.ml_accounts;

create trigger ml_accounts_stamp_creator
  before insert on public.ml_accounts
  for each row execute function private.stamp_ml_account_creator();
