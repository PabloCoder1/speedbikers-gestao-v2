-- ============================================================
-- Fecha o EXECUTE que o Supabase concede por padrao a anon/authenticated em
-- toda funcao nova do schema public.
--
-- Achado pelo linter de seguranca do Supabase logo depois de
-- `20260821000000_create_link_candidates.sql` ir ao ar: `revoke ... from
-- public` na migration original nao bastou. O projeto concede EXECUTE
-- diretamente aos papeis `anon` e `authenticated` na criacao da funcao — via
-- default privileges do Supabase, nao via o pseudo-papel PUBLIC — e por isso
-- so um `revoke from public` deixa `anon` com acesso.
--
-- Nao e uma falha explorada: as duas funcoes reautenticam por dentro
-- (`private.is_member_of`, `private.has_account_access`, `private.has_role`),
-- e `auth.uid()` retorna NULL para `anon`, entao a chamada sempre falhava com
-- "sem permissao". Mas GRANT e a primeira barreira, nao a segunda
-- (`docs/DATABASE.md` secao 5), e a diferenca importa: sem esta migration,
-- toda funcao security definer nova nasce executavel por anon ate alguem
-- notar o linter.
-- ============================================================

revoke execute on function public.resolve_link_candidate(uuid, uuid) from anon, authenticated;
revoke execute on function public.dismiss_link_candidate(uuid) from anon, authenticated;

grant execute on function public.resolve_link_candidate(uuid, uuid) to authenticated;
grant execute on function public.dismiss_link_candidate(uuid) to authenticated;
