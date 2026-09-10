-- ============================================================
-- `get_ml_account_cards`: os tres numeros por conta que o frame `Accounts`
-- desenha e que `/contas` nunca mostrou (D-299, fatia A8).
--
-- O frame poe tres linhas de detalhe em cada cartao de conta:
--
--   | o que ele desenha           | tem fonte? |
--   |---|---|
--   | "Ultima sincronizacao"      | SIM -- `sync_runs.finished_at` por conta |
--   | "Anuncios sincronizados"    | SIM -- `listings` por conta |
--   | "Permissoes"                | SIM -- `ml_credentials.scopes` |
--
-- ------------------------------------------------------------
-- POR QUE UMA FUNCAO, E POR QUE ELA E `security definer`
-- ------------------------------------------------------------
-- `ml_credentials` guarda o CIFRADO do token. Medido antes de escrever: a
-- tabela tem RLS ligada, **zero policies e zero grants** para `anon` e
-- `authenticated`. Isso e desenho, nao lacuna -- a web nao chega perto de
-- cofre de credencial, e nao e esta fatia que vai abrir.
--
-- A janela e esta funcao, com quatro travas:
--
--   1. **o MESMO predicado da policy da tabela de contas.** Nao inventei
--      guard novo: `ml_accounts_select_permitted` diz
--      `id in (accessible_accounts()) or has_org_role(org, ADMIN)`, e e isso
--      que esta aqui. Um guard so de "ADMIN da organizacao" seria mais
--      restrito que a tela (GESTOR perderia as contas que ja ve); um guard de
--      "membro da organizacao" seria mais FROUXO. Copiar o predicado mantem
--      UMA definicao de quem ve conta;
--   2. **nenhum campo de credencial sai.** Nem `access_token_ciphertext`, nem
--      `refresh_token_ciphertext`, nem `encryption_key_version`. O que sai de
--      `ml_credentials` sao dois DERIVADOS: quantos escopos, e se o token ja
--      passou da validade;
--   3. **nem o instante de expiracao sai.** `token_expired` e booleano de
--      proposito -- a tela nao tem o que fazer com o instante, e divulgar
--      menos e melhor num cofre. O `credential_updated_at`, esse sai, porque
--      e o que diz que a renovacao esta viva;
--   4. `search_path` travado, `revoke` de `public`/`anon`, `grant` explicito.
--
-- ------------------------------------------------------------
-- O TOKEN VIVE 6 HORAS, E ISSO MUDA O QUE A TELA PODE DIZER
-- ------------------------------------------------------------
-- O frame escreve "Token expira em 2 dias" como se expirar fosse alerta.
-- Medido no Dev em 2026-09-10, nas quatro contas:
--
--   vida do token: 6,0 h  (as quatro, exatamente)
--   credencial renovada ha: 1,7 / 2,2 / 4,4 / 4,5 h
--   faltando para expirar: 1,5 / 1,6 / 3,8 / 4,3 h
--
-- Renovar e ROTINA do worker, o dia inteiro. Uma contagem regressiva na tela
-- estaria sempre em "expira em poucas horas" -- alarme permanente numa
-- operacao saudavel, que e a forma mais rapida de ensinar alguem a ignorar
-- alarme.
--
-- O que a expiracao diz de verdade e o caso raro: token VENCIDO numa conta
-- `CONNECTED` significa que a renovacao parou. Por isso o retorno e
-- `token_expired`, nao "expira em X".
-- ============================================================

create function public.get_ml_account_cards(p_organization_id uuid)
returns table (
  id uuid,
  label text,
  slug text,
  seller_id bigint,
  status text,
  connected_at timestamptz,
  last_error text,
  listings_count bigint,
  last_sync_at timestamptz,
  scope_count integer,
  credential_updated_at timestamptz,
  token_expired boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id,
    a.label,
    a.slug,
    a.seller_id,
    a.status,
    a.connected_at,
    a.last_error,
    -- Contagem por conta em SQL, nunca uma consulta por cartao no servidor
    -- do Next (`docs/ARCHITECTURE.md` secao 21).
    (select count(*) from public.listings l where l.ml_account_id = a.id) as listings_count,
    (select max(s.finished_at)
       from public.sync_runs s
      where s.ml_account_id = a.id and s.status = 'done') as last_sync_at,
    array_length(c.scopes, 1) as scope_count,
    c.updated_at as credential_updated_at,
    -- Vencido numa conta conectada = a renovacao parou. Sem credencial, nao
    -- ha o que afirmar: `null`, e a tela diz "sem credencial" em vez de
    -- "em dia" (D-067 -- ausencia nao e o valor benigno).
    case when c.access_token_expires_at is null then null
         else c.access_token_expires_at < now() end as token_expired
  from public.ml_accounts a
  left join public.ml_credentials c on c.ml_account_id = a.id
  where a.organization_id = p_organization_id
    -- O MESMO predicado de `ml_accounts_select_permitted`. Uma definicao de
    -- quem ve conta, nao duas.
    and (
      a.id in (select private.accessible_accounts())
      or private.has_org_role(a.organization_id, array['ADMIN'])
    )
  order by a.label
$$;

comment on function public.get_ml_account_cards(uuid) is
  'Cartoes de conta de /contas (D-299): identidade, anuncios sincronizados, ultima sincronizacao e os dois derivados de ml_credentials (quantos escopos, e se o token venceu). security definer porque ml_credentials tem RLS sem policy nenhuma -- a web nao le cofre de token. NENHUM campo cifrado sai, e nem o instante de expiracao: token_expired e booleano porque o token do ML vive 6h e e renovado o dia inteiro, entao contagem regressiva seria alarme permanente. O predicado de autorizacao e COPIA do de ml_accounts_select_permitted, para nao existir uma segunda definicao de quem ve conta.';

revoke all on function public.get_ml_account_cards(uuid) from public, anon;
grant execute on function public.get_ml_account_cards(uuid) to authenticated, service_role;
