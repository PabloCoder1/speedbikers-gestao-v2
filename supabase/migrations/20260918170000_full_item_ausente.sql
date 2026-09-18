-- ============================================================
-- fulfillment_item_absences -- a marca de "este anuncio respondeu 404/403"
-- que tira o item da varredura do Full ate a hora do recheque.
--
-- MEDIDO EM PRODUCAO (imvjfgna..., logs do worker e sync_runs, 15/09 03:00 a
-- 18/09 09:00 UTC, 15 execucoes de `sync.fulfillment.snapshot`):
--
--   * os MESMOS 356 pares (conta, item_id) responderam 404 em
--     `GET /items/{id}` em 14 das 15 execucoes -- 79, 40, 111 e 126 por
--     conta, nenhum par entrou nem saiu. A 15a e a de 403 em tudo, abaixo.
--     Com a cadencia de 6 h, sao 1.424 chamadas por dia para ouvir a mesma
--     resposta;
--   * em 16/09 21:00 UTC as quatro contas receberam 403 em TODOS os 3.220
--     itens, dentro de ~7 s, e as quatro terminaram `done` com
--     `processed = 0`. Falha em massa, nao de item: a execucao seguinte
--     (17/09 03:00) capturou normalmente.
--
-- O worker (`apps/worker/src/handlers/ml-fulfillment-fetch.ts`) grava aqui a
-- falha 404/403 de um item e pula o item enquanto `recheck_after` nao chega.
-- As janelas moram no codigo, nao aqui: 9 h para 403 e para o primeiro 404,
-- 45 h a partir do segundo 404 seguido (o porque de cada numero esta no
-- comentario das constantes e em docs/PERFORMANCE.md). Sucesso posterior
-- APAGA a linha, e a marca de item que saiu de `sku_listing_links` tambem sai
-- na execucao seguinte: a tabela guarda so item vinculado.
--
-- POR QUE UMA TABELA PROPRIA, e nao uma coluna:
--
--   * `sku_listing_links` e o vinculo curado (importado ou confirmado por
--     humano), com historico em `sku_listing_link_events` e dois gatilhos
--     por linha (`set_updated_at` e `validate_org`). Uma marca operacional
--     reescrita pelo worker a cada 6 h mexeria no `updated_at` que a
--     /vinculacoes le -- o vinculo pareceria editado sem ninguem ter mexido
--     -- e rodaria a validacao de organizacao a cada marca;
--   * `listings` nao serve: em 18/09, 667 dos 3.753 vinculos sem variacao
--     nao tem linha em `listings`. O anuncio morto e justamente o que o
--     snapshot de anuncios nao traz, entao a marca nao teria onde morar;
--   * a marca e do PAR (conta, item_id), nao do vinculo. Refazer o vinculo
--     para outro anuncio gera um item_id sem marca, buscado na hora, e a
--     marca do anuncio antigo sai na execucao seguinte; recriar o vinculo
--     para o mesmo anuncio morto custa no maximo as duas consultas do comeco
--     de uma sequencia, nao 1.424 chamadas por dia.
--
-- NADA AQUI PODE ESCONDER ESTOQUE PARA SEMPRE. Toda marca vence
-- (`recheck_after` e obrigatorio e posterior a falha), entao o pior caso de
-- uma janela errada e atraso de captura. Atraso nao e gratis: o "Full atual"
-- aceita snapshot de ate 3 dias (D-173), e se as execucoes vizinhas tambem
-- falharem o bucket pode sair das telas ate a proxima captura -- a conta
-- esta em docs/PERFORMANCE.md. O worker trata esta tabela como
-- OTIMIZACAO: se a leitura falhar (inclusive se o codigo chegar antes desta
-- migration), ele loga e busca todos os itens, que e o comportamento de antes.
--
-- VOLTA: `drop table public.fulfillment_item_absences;` -- nenhuma outra
-- tabela nem funcao depende dela, e o worker sem a tabela volta a buscar
-- todo item a cada execucao (loga `fulfillment_item_absences_unreadable`).
-- ============================================================

create table public.fulfillment_item_absences (
  -- `cascade`, diferente de fulfillment_stock_snapshots (`restrict`): isto nao
  -- e historico, e estado operacional de uma conta. Conta que sai leva as
  -- marcas junto.
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  item_id text not null check (item_id ~ '^MLB[0-9]+$'),

  -- A ultima resposta: com `failures`, define a janela do recheque. Outro
  -- status nao retryable (400, 401...) nao vira marca -- 401 e da conta, nao
  -- do item.
  http_status smallint not null check (http_status in (403, 404)),

  -- Falhas SEGUIDAS desde `first_failed_at`: sucesso apaga a linha, entao a
  -- contagem recomeca do 1. O 404 so ganha a janela longa na segunda.
  failures integer not null default 1 check (failures >= 1),
  first_failed_at timestamptz not null,
  last_failed_at timestamptz not null,

  -- A partir de quando o worker volta a perguntar ao Mercado Livre.
  recheck_after timestamptz not null,

  created_at timestamptz not null default now(),

  constraint fulfillment_item_absences_pkey primary key (ml_account_id, item_id),
  constraint fulfillment_item_absences_order check (
    first_failed_at <= last_failed_at and last_failed_at < recheck_after
  )
);

comment on table public.fulfillment_item_absences is
  'Item que respondeu 404/403 em GET /items/{id} no snapshot do Full: o worker pula o item ate recheck_after. Sucesso apaga a linha. Otimizacao -- sem ela o worker busca tudo.';

comment on column public.fulfillment_item_absences.recheck_after is
  'Antes disto o item nao e buscado. 403 e primeiro 404: 9 h; 404 a partir do segundo seguido: 45 h (janelas no worker, docs/PERFORMANCE.md).';

comment on column public.fulfillment_item_absences.failures is
  'Falhas seguidas desde first_failed_at. Com 404, a partir da segunda a janela e a longa (45 h). Sucesso apaga a linha.';

-- A leitura do worker e "todas as marcas da conta", uma vez por execucao --
-- a PK ja e esse prefixo. Nenhum indice a mais.

-- ============================================================
-- RLS -- mesmo desenho de metric_refresh_state (D-304): quem alcanca a conta
-- LE as marcas (a /vinculacoes pode um dia mostrar "anuncio sumiu"); so o
-- worker escreve. O `revoke all` de antes do grant nao e estilo: o default
-- ACL do schema concede escrita a `authenticated` em toda tabela nova
-- (D-130), e a guarda de GRANTs do rls.integration.test.ts reprova escrita
-- sem policy.
-- ============================================================

alter table public.fulfillment_item_absences enable row level security;

create policy fulfillment_item_absences_select_permitted
  on public.fulfillment_item_absences for select to authenticated
  using (ml_account_id in (select private.accessible_accounts()));

revoke all on public.fulfillment_item_absences from anon, authenticated, service_role;
grant select on public.fulfillment_item_absences to authenticated;
grant select, insert, update, delete on public.fulfillment_item_absences to service_role;
