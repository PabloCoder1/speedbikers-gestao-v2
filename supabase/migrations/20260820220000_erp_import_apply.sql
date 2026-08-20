-- ============================================================
-- Resultado da aplicacao do lote.
--
-- Quarta etapa do fluxo `upload -> parse -> conferencia -> APLICACAO`.
--
-- A conferencia responde "o que este arquivo diz?". Estas colunas respondem
-- "o que aconteceu quando mandei aplicar?" — que e uma pergunta diferente e
-- igualmente necessaria. Sem elas, uma linha que nao pode ser aplicada
-- (o SKU nao existe, a conta nao existe) desapareceria: a contagem final
-- mostraria menos linhas que o arquivo e ninguem saberia quais.
--
-- Ficam na MESMA linha que foi conferida, de proposito. Quem revisou a linha
-- 4.312 volta nela e ve o desfecho, sem cruzar tabela.
-- ============================================================

alter table public.erp_import_rows
  add column apply_status text
    check (apply_status is null or apply_status in ('APPLIED', 'UNRESOLVED', 'FAILED')),
  add column apply_reason text;

comment on column public.erp_import_rows.apply_status is
  'NULL enquanto nao aplicada. UNRESOLVED = linha valida cuja dependencia nao '
  'existe (SKU ou conta ausente); nao e erro do arquivo.';

-- Filtrar as pendencias e a consulta que a tela de conferencia faz depois de
-- aplicar. Parcial porque a esmagadora maioria das linhas fica em APPLIED.
create index erp_import_rows_unresolved_idx
  on public.erp_import_rows (batch_id)
  where apply_status in ('UNRESOLVED', 'FAILED');

alter table public.erp_import_batches
  add column applied_rows integer check (applied_rows is null or applied_rows >= 0),
  add column unresolved_rows integer check (unresolved_rows is null or unresolved_rows >= 0);

comment on column public.erp_import_batches.applied_rows is
  'Linhas que chegaram ao dominio. Diferente de ok_rows, que conta apenas as '
  'que o parser entendeu.';

-- ============================================================
-- Contas do Mercado Livre criadas pela importacao.
--
-- O arquivo de vinculos nomeia lojas que ainda nao passaram por OAuth. Criar a
-- conta em `PENDING` e correto: a conta EXISTE na operacao, so nao esta
-- conectada. Inventar credencial seria mentira; recusar o arquivo inteiro por
-- causa disso jogaria fora 20.650 vinculos reais.
-- ============================================================

alter table public.ml_accounts
  add column created_by_import boolean not null default false;

comment on column public.ml_accounts.created_by_import is
  'Conta deduzida do nome da loja na exportacao do UpSeller, ainda sem OAuth. '
  'Serve para a tela de contas mostrar o que falta conectar.';
