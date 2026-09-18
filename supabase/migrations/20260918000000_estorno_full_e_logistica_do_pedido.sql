-- ============================================================
-- D-352 -- a venda entregue pelo Full nao baixa o estoque da LOJA.
--
-- O problema medido (2026-09-17, producao, so SELECT): `VENDA_ML` sem par de
-- estorno sao 2.667 linhas / 2.768 unidades em 2.550 pedidos, TODOS com
-- `shipping_id`; 66 SKUs terminam com alvo LOCAL negativo, somando -406. A
-- unidade que o Mercado Livre despachou do galpao DELE saiu do saldo da loja,
-- que nunca a teve.
--
-- Esta migration abre as duas portas que faltavam, e nada mais:
--
--   1. `stock_movements.movement_type` ganha `ESTORNO_FULL` -- o par que anula
--      a venda do Full, na forma que a D-351 ja aprovou (mesma chave neutra
--      `estorno:<chave da venda>`, `occurred_at` espelhado, `created_by` nulo,
--      soma zero no saldo E no alvo de `compute_erp_target_balances`);
--   2. `orders` ganha `logistic_type` e `logistic_captured_at` -- o sinal que a
--      V3 hoje NAO tem. O pedido (`GET /orders/{id}`) traz so `shipping: { id }`;
--      quem diz de onde a venda sai e `GET /shipments/{id}.logistic_type`
--      (leitura real de 17/09: `"fulfillment"` em 3 envios, `"cross_docking"`
--      em 1).
--
-- **Nenhum `location_kind` novo, e nenhum movimento de CD** (D-018: o Full e
-- ESPELHO, nao ledger). O CHECK de `location_kind` continua LOCAL/RESERVADO/
-- TRANSITO, e `packages/db/src/rls.integration.test.ts` continua fixando que
-- 'FULL' e recusado. A venda do Full nao vira linha em outro lugar: ela vira um
-- PAR que soma zero.
--
-- ORDEM DE PUBLICACAO: esta migration ANTES do worker, como em
-- `20260916180200`. O worker novo grava `ESTORNO_FULL` e `logistic_type`;
-- contra o schema antigo o flush da pagina aborta (`page-writes.ts`) e o job
-- retenta -- nunca grava metade do par.
-- ============================================================

-- ------------------------------------------------------------
-- 1. `ESTORNO_FULL` no vocabulario dos movimentos
-- ------------------------------------------------------------
-- Tipo proprio, e nao `ESTORNO_PRE_CAPTURA`, pela mesma razao que separou o
-- `ESTORNO_REVERSAO_EXCEDENTE` em D-351: o TIPO diz a CAUSA. "A planilha do
-- UpSeller ja tinha descontado esta venda" e "esta venda saiu do galpao do
-- Mercado Livre" sao dois fatos diferentes sobre o mesmo saldo, e quem for
-- medir o efeito do Full (ou desfaze-lo) precisa distingui-los.
--
-- E nao `AJUSTE_MANUAL`: ele exige `created_by` e `reason`
-- (`stock_movements_manual_has_creator`/`_has_reason`), e atribuir a linha de
-- sistema ao unico ADMIN seria autoria falsa. Nem `AJUSTE_RECONCILIACAO`, que
-- fica FORA do alvo enquanto a venda fica dentro -- o par tem de cair do MESMO
-- lado do corte, e e por isso que ele espelha o `occurred_at` da venda.
--
-- A CHAVE continua neutra (`estorno:<chave da venda>`, `sale-deduction.ts`): com
-- um prefixo por causa, a venda que e anterior a planilha E do Full ganharia
-- duas chaves diferentes e o `UNIQUE` deixaria os dois estornos entrarem (+1).
-- Com a chave neutra, o `UNIQUE` que ja existe absorve o segundo.
--
-- **O CHECK e recriado INTEIRO, entao a lista parte do ULTIMO que o criou**, nao do
-- que existia quando esta fatia comecou. Os 15 valores anteriores sao os de
-- `20260917230000_documentos_pdf.sql` (D-375): os 14 de
-- `20260916180200_estorno_pre_captura_e_fonte_backfill.sql` mais `SAIDA_DOCUMENTO`,
-- repetidos sem alteracao; `ESTORNO_FULL` e o 16o. A primeira versao desta migration
-- partiu da 20260916180200 e APAGAVA `SAIDA_DOCUMENTO`: com linha dele no banco o
-- `add constraint` abortaria (23514); sem linha, passaria calada e todo documento de
-- saida aplicado depois levaria 23514 no `nfe-import-apply`. O teste
-- `packages/db/src/movement-type-check.test.ts` exige no ultimo CHECK todo tipo que o
-- worker grava -- e a trava para a proxima migration que mexer aqui.
alter table public.stock_movements drop constraint stock_movements_movement_type_check;

alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'ENTRADA_NFE', 'SAIDA_NFE', 'VENDA_ML', 'CANCELAMENTO_ML', 'DEVOLUCAO_ML',
  'AJUSTE_MANUAL', 'AJUSTE_RECONCILIACAO', 'TRANSFERENCIA',
  'RESERVA', 'LIBERACAO_RESERVA', 'ENTRADA_TRANSITO', 'RECEBIMENTO_TRANSITO',
  'ESTORNO_PRE_CAPTURA', 'ESTORNO_REVERSAO_EXCEDENTE',
  -- D-375: saida conferida por documento NAO fiscal (20260917230000).
  'SAIDA_DOCUMENTO',
  -- D-352: o par da venda entregue pelo Full.
  'ESTORNO_FULL'
));

-- ------------------------------------------------------------
-- 2. A logistica do pedido
-- ------------------------------------------------------------
-- **Sem CHECK de valor, de proposito.** O vocabulario de `logistic_type` e do
-- Mercado Livre, nao da V3: `fulfillment`, `cross_docking`, `drop_off`,
-- `xd_drop_off`, `self_service`, `custom` aparecem na documentacao, e nada
-- promete que a lista esta fechada. Um CHECK aqui transformaria um valor novo
-- do ML em falha de gravacao de PEDIDO -- o job inteiro abortando por causa de
-- um rotulo. O valor entra CRU, e a decisao e do dominio: `=== 'fulfillment'`
-- e Full; qualquer outra coisa -- inclusive desconhecida e inclusive NULL --
-- baixa a loja, que e o comportamento conservador de hoje (D-352, R6).
--
-- NULL em `logistic_type` tem DOIS significados, e e `logistic_captured_at` que
-- os separa:
--   * `logistic_captured_at` NULO  = o sinal nunca foi lido (o envio nao foi
--     consultado, ou a consulta falhou). O pedido fica PENDENTE: baixa a loja
--     agora e ganha o `ESTORNO_FULL` quando o sinal chegar `fulfillment` (R2).
--   * `logistic_captured_at` PREENCHIDO com `logistic_type` nulo = o envio foi
--     lido e NAO disse a logistica. Nao e pendencia, e resposta: baixa a loja.
--
-- Uma vez capturado, o valor NAO e reescrito por releitura divergente (R5): o
-- worker carrega o valor gravado no upsert do pedido e registra a divergencia
-- no log, e o trigger da secao 3 garante o mesmo no banco. O ledger e
-- append-only; uma decisao que muda de ideia depois de gravar o par deixaria o
-- saldo com a metade de dois desenhos diferentes.
alter table public.orders
  add column logistic_type text,
  add column logistic_captured_at timestamptz;

comment on column public.orders.logistic_type is
  'Valor CRU de logistic_type do envio (GET /shipments/{id}), sem CHECK: o vocabulario e do Mercado Livre (D-352). Só ''fulfillment'' e Full e nao baixa a loja; qualquer outro valor, e NULL, baixam. NULL com logistic_captured_at preenchido = o envio foi lido e nao disse.';

comment on column public.orders.logistic_captured_at is
  'Quando a V3 leu o envio deste pedido (D-352). NULO = sinal nunca lido, e o pedido fica pendente do ESTORNO_FULL. Preenchido = lido, e logistic_type é a resposta (mesmo nula). Nunca reescrito por releitura (R5).';

-- **Sem indice, e isto e uma escolha medida.** Os consumidores destas duas
-- colunas leem o pedido pela PRIMARY KEY: `persist-order.ts` (por pedido ou por
-- `in (...)` de uma pagina) e a varredura `sync-order-logistics.ts`, que parte do
-- LEDGER e so depois pede os pedidos por `in (...)`. Nenhum varre `orders` por
-- `logistic_type` nem por `logistic_captured_at is null`, e um indice parcial aqui
-- seria escrita a mais em 331 mil linhas para uma consulta que nao existe.

-- ------------------------------------------------------------
-- 3. A captura so nasce uma vez -- no banco, e nao so no worker (R5)
-- ------------------------------------------------------------
-- A varredura carimba com `update ... where logistic_captured_at is null`, mas o
-- upsert de `orders` em `persist-order.ts` e `DO UPDATE` com o valor que ELE leu
-- no comeco da execucao. Se a varredura carimbar entre essa leitura e o upsert
-- (uma pagina da janela horaria, ou o webhook de um pedido cancelado que nao le o
-- envio), o upsert regrava as duas colunas NULAS por cima -- e o pedido volta a
-- "sinal nunca lido" com o `ESTORNO_FULL` ja no ledger. A janela e de segundos,
-- mas o estado que ela deixa e o pior: o cancelamento seguinte sai pelo caminho
-- nao-Full e devolve +1 a loja (revisao de 6965b0e, BAIXA).
--
-- O trigger fecha a corrida sem mexer no lote da pagina (o PostgREST exige as
-- MESMAS colunas em todas as linhas de um upsert, entao omitir as duas so no
-- pedido que nao leu o envio nao e uma opcao): captura gravada nunca volta a
-- nula, e nunca troca de valor. Quem precisar corrigir uma captura a mao (nao ha
-- fluxo para isso) desabilita o trigger na mesma transacao, de proposito.
create function private.orders_logistica_congelada()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.logistic_captured_at is not null then
    new.logistic_type := old.logistic_type;
    new.logistic_captured_at := old.logistic_captured_at;
  end if;

  return new;
end;
$$;

comment on function private.orders_logistica_congelada is
  'D-352 (R5): a captura da logistica do envio so nasce uma vez. Captura gravada nunca volta a nula nem troca de valor -- nem pelo upsert do pedido que leu a linha antes de a varredura carimbar.';

create trigger orders_logistica_congelada
  before update of logistic_type, logistic_captured_at on public.orders
  for each row execute function private.orders_logistica_congelada();
