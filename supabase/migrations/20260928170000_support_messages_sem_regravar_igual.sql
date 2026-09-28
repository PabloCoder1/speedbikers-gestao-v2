-- ============================================================
-- `support_messages`: o upsert que nao muda nada deixa de regravar a linha
-- (auditoria de 2026-09-28).
--
-- O SINTOMA. Em producao, de 18 a 28/09: 171.997 UPDATEs para ~6,4 mil
-- mensagens -- ~27 regravacoes por linha. Cada sincronizacao de conversa,
-- pergunta ou reclamacao faz `upsert` do transcript inteiro, e toda linha
-- regravada e tupla morta, WAL e manutencao de indice, que o decodificador
-- do Realtime (o maior consumidor do banco no periodo) tambem atravessa.
--
-- POR QUE NO BANCO, e nao no worker. Os tres caminhos que gravam mensagens
-- (`persist-support-conversation.ts`, `-question.ts`, `-claim.ts`) mandam o
-- transcript inteiro; dois deles reenviam `observed_at` = instante da leitura,
-- entao a linha "muda" a cada rodada mesmo com o conteudo igual. Nenhum leitor
-- usa `observed_at` (nem a `web`, nem funcao SQL; conferido). O gatilho
-- compara a linha nova com a antiga IGNORANDO `observed_at` e `updated_at`, e
-- pula a atualizacao quando o resto e igual. Mudanca real de conteudo, estado
-- remoto ou corpo continua sendo gravada.
--
-- SEM RETURNING DEPENDENTE: nenhum dos tres upserts le as linhas devolvidas
-- (conferido), entao a linha pulada nao muda o que o worker ve.
-- `support_cases` NAO entra: o `update` do caso usa `.select("id").single()`,
-- e a linha pulada voltaria vazia.
--
-- `observed_at` passa, na pratica, a dizer "ultima vez em que a mensagem
-- mudou (ou foi vista pela primeira vez)" -- o que o caminho das reclamacoes
-- ja fazia, porque nunca o enviou.
--
-- ENSAIO no Dev, em rollback: upsert identico com `observed_at` novo manteve
-- o `xmin` e o `updated_at`; upsert com o corpo mudado gravou.
-- ============================================================

create function private.support_messages_skip_unchanged()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (to_jsonb(new) - 'observed_at' - 'updated_at') = (to_jsonb(old) - 'observed_at' - 'updated_at') then
    return null;
  end if;

  return new;
end;
$fn$;

comment on function private.support_messages_skip_unchanged() is
  'BEFORE UPDATE de support_messages: pula a regravacao quando so observed_at/updated_at mudariam (auditoria de 2026-09-28).';

create trigger support_messages_a_skip_unchanged
  before update on public.support_messages
  for each row execute function private.support_messages_skip_unchanged();
