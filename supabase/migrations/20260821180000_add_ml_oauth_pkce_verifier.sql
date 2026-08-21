-- O app Mercado Livre da V3 exige PKCE. O `code_verifier` precisa sobreviver
-- ao redirecionamento sem ir ao navegador; a api o cifra com a mesma chave
-- AES-256-GCM dos tokens e o recupera no callback (D-049).

alter table public.ml_oauth_states
  add column code_verifier_ciphertext text;

alter table public.ml_oauth_states
  add constraint ml_oauth_states_pkce_verifier_looks_encrypted check (
    code_verifier_ciphertext is null
    or char_length(code_verifier_ciphertext) between 80 and 400
  );

comment on column public.ml_oauth_states.code_verifier_ciphertext is
  'Code verifier PKCE cifrado pela api. NULL apenas para states anteriores a D-049.';
