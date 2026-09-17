-- D-351 F3 -- compensacao do que o worker antigo gravou (ou deixou de gravar) para vendas
-- que a planilha do UpSeller ja tinha descontado.
--
-- NAO E MIGRATION, de proposito. Precisa rodar DEPOIS do deploy do worker de D-351:
-- enquanto o worker antigo estiver no ar ele continua gravando VENDA_ML de pedido
-- antigo, e uma compensacao aplicada antes deixaria essas novas sem par. Como a
-- selecao e por regra, rodar de novo depois pega o que tiver sobrado (e idempotente).
-- Se virar migration, copie este corpo para um arquivo com instante valido.
--
-- PRE-REQUISITOS
--   1. migrations de D-351 aplicadas (o tipo ESTORNO_PRE_CAPTURA, o corte da exportacao
--      em `erp_stock_snapshots.captured_at` e a RPC das devolucoes). CONFERIDO no bloco, em
--      TODA organizacao sem AJUSTE_RECONCILIACAO (as que o UPDATE de 20260916180000 corrige):
--      snapshot de planilha com o nome carimbado que ainda carrega o PARSE como corte aborta
--      tudo -- com o corte do parse (18:44:13 em producao) a F3 estornaria venda legitima da
--      janela entre exportacao e parse (2000018457209778, fechada as 18:43:57). Isso tambem
--      pega uma planilha importada pelo worker ANTIGO entre a migration e o deploy. Essa
--      planilha leva o corte da organizacao para o parse dela, e a de producao deixa de ser
--      elegivel: ate a reverificacao de 60c7a6a a conferencia olhava so as elegiveis, e a F3
--      pulava a organizacao em silencio em vez de parar (BAIXA-1). O UPDATE refeito tira o
--      aborto, mas nao devolve a elegibilidade: QUALQUER planilha importada antes da F3 torna
--      a organizacao de producao inelegivel, e a F3 vira no-op -- NOTICE "fora do criterio",
--      0 estornos e 0 reposicoes --, o que pede decisao do dono. Por isso a conferencia e o
--      UPDATE refeito vem ANTES do deploy do worker (DEPLOYMENT.md 8.2, passo 10), e nenhuma
--      planilha entra ate a F3;
--   2. worker de D-351 servindo trafego;
--   3. `v3-reconcile-balances` AINDA pausado -- a organizacao com AJUSTE_RECONCILIACAO
--      nao e compensada (abaixo).
--
-- A CHAVE e NEUTRA: `estorno:<chave do movimento estornado>`, a mesma do worker
-- (`estornoKeyOf` em `@sb/domain`). O tipo diz a causa, a chave diz o movimento: um
-- segundo estorno do mesmo movimento, de qualquer produtor, cai no UNIQUE.
--
-- PARTE 1 -- VENDA_ML gravado sem par (a regra do worker, `@sb/domain/inventory`):
--   afetado = VENDA_ML de pedido cuja "venda em" (`date_closed ?? date_created`) e <= o
--             corte do SKU (o `max(captured_at)` do SKU; sem snapshot proprio, o da
--             organizacao) e que ainda nao tem `estorno:<chave>`.
--   EXCETO a venda cujo CANCELAMENTO_ML aconteceu ate o corte: a planilha ja tinha a
--             unidade de volta, e o par venda/cancelamento ja soma zero.
--   estorno  = ESTORNO_PRE_CAPTURA com quantidade oposta e `occurred_at` ESPELHADO do
--             VENDA_ML -- o par soma zero no saldo E no alvo de
--             `compute_erp_target_balances` (as duas linhas ficam do mesmo lado do corte).
--             `created_by` nulo: linha de sistema.
--   CANCELAMENTO_ML e DEVOLUCAO_ML nao sao compensados: aconteceram depois da planilha e
--             sao verdade nossa (resposta do dono: o UpSeller devolve a unidade sozinho) --
--             exceto a reversao a mais da mesma venda, anulada na parte 1B.
--   A QUANTIDADE e a venda INTEIRA. Ate a reverificacao de cc90baa o estorno era a venda
--             menos o excesso de reversao do legado, e isso so fechava com a venda e a
--             reversao a mais do mesmo lado do corte (D-351 §12, abaixo).
--   Aqui NAO entra o "gravada antes de o corte chegar" do worker: so a organizacao que
--   nunca reconciliou e elegivel, e nela o saldo ainda nao foi alinhado a planilha nenhuma.
--
-- PARTE 1B -- a reversao a mais do legado (reverificacao de cc90baa, D-351 §12):
--   uma unidade vendida volta ao estoque no maximo uma vez, mas antes do limite das
--   reversoes (verificacao de e6fda07, ALTA-1) o worker gravava cancelamento E devolucao da
--   mesma venda. Para cada VENDA_ML com ESTORNO_PRE_CAPTURA (o da parte 1 ou o do worker novo)
--   e revertido R > V (V = unidades vendidas), o excesso E = R - V e atribuido as reversoes
--   MAIS RECENTES pelo `occurred_at` (no empate, a chave maior em `collate "C"`), cada uma
--   cedendo no maximo a propria quantidade -- `excessReversalShares` em `@sb/domain`. Cada
--   parte vira ESTORNO_REVERSAO_EXCEDENTE com o sinal da venda, o SKU, o local e a origem da
--   venda, a chave neutra `estorno:<chave da reversao>` e o `occurred_at` ESPELHADO da
--   reversao. Conta de cada venda: saldo = -V + V + R - E = min(R, V); no alvo, cada par
--   (venda, estorno) e (reversao, anulacao) fica do mesmo lado do corte, qualquer que seja o
--   lado da venda. O estorno de V - E com a data da venda deixava o alvo +E quando a venda
--   estava ATE o corte e a reversao a mais depois: 2000017792822486, KIT de 3 componentes,
--   VENDA_ML com `occurred_at` 09-14 18:11:20, DEVOLUCAO_ML 09-16 00:12:31 e CANCELAMENTO_ML
--   09-16 12:58:04 -- alvo +2 para real +1 em cada componente. Medido em producao em
--   2026-09-16 17:40 UTC (so SELECT, corte 18:42:00): 20 VENDA_ML de 18 pedidos com excesso,
--   todas com V = 1, R = 2 e duas reversoes, 3 com a venda fora do alvo (o KIT), 0 reversoes
--   ate o corte, e a mesma reversao a mais pelo `occurred_at` e pelo `created_at` nas 20.
--
-- PARTE 2 -- a venda que o worker antigo NUNCA gravou (revisao de D-351, ALTA-2):
--   pedido hoje cancelado, com item vinculado (`order_items.sku_id`), `date_closed` <= o
--   corte, sem NENHUM VENDA_ML do pedido (por origem, nao pela chave de hoje: verificacao
--   de e6fda07, MEDIA-1), e com um `order.cancelled` de `before.status` venda valida
--   (`paid`/`partially_refunded`) cujo `occurred_at` e POSTERIOR ao corte. A planilha tem
--   a venda descontada e o UpSeller devolveu a unidade depois dela: o real e snapshot +1.
--   Grava o trio que o worker novo grava (`computeCancellationMovements`): VENDA_ML e
--   ESTORNO_PRE_CAPTURA com `occurred_at` = `date_closed`, e CANCELAMENTO_ML com
--   `occurred_at` = o do evento. KIT decompoe pelos componentes de hoje, como o worker.
--   Sem a transicao observada (`before.status` nulo: o backfill trouxe ja cancelado) nao
--   mexe -- esse cancelamento pode ser anterior a planilha. Medido em producao em
--   2026-09-15 (so SELECT, esta selecao com o corte 18:42:00): 20 pedidos, 20 movimentos
--   (um deles componente de KIT), 21 unidades, eventos de 09-14 18:47:13 a 09-15 05:46:27.
--
-- QUAIS ORGANIZACOES. So a que "nasceu no import": tem snapshot, NENHUM
-- AJUSTE_RECONCILIACAO, e o primeiro movimento do ledger e posterior a (corte - 1 h).
-- Em producao (2026-09-14): primeiro VENDA_ML as 18:43:59, corte 18:42:00, zero ajustes.
-- No Dev (ledger de 08-21 com reconciliacoes) e na CI vazia: nao faz nada. Organizacao
-- com afetados que fica de fora sai em NOTICE -- nunca some em silencio. Se alguem
-- despausar a reconciliacao antes, a organizacao deixa de ser elegivel: rode a PROVA 1.
--
-- COMO RODAR: por psql, como postgres -- o SQL Editor do Supabase nao mostra os NOTICE, e
-- sao eles que dizem quantos estornos e reposicoes entraram e que organizacao ficou de fora
-- (`psql "$URL" -v ON_ERROR_STOP=1 -f compensacao-estorno-pre-captura-d351.sql`). O bloco e
-- atomico e termina com asserções que abortam tudo se falharem. Para restringir a UMA
-- organizacao (e o que o teste de integracao faz):
--     begin;
--     set local sb.compensacao_organizacao = '<uuid>';
--     <este arquivo>
--     commit;
--
-- COMO FOI PROVADO: `packages/db/src/estoque-pre-captura.integration.test.ts`, bloco
-- "compensacao F3", contra Postgres real -- compensa so o que deve, espelha a data, repoe
-- a venda nunca gravada (PRODUTO e KIT) so com a transicao observada depois do corte, o
-- alvo fecha em snapshot + legitimos + reposicoes, a segunda execucao grava 0, a
-- organizacao reconciliada nao e tocada, e o corte do parse aborta -- tambem na organizacao
-- que a planilha nova tornou inelegivel, que com o UPDATE refeito vira no-op com NOTICE.
-- A parte 1B tem o bloco "a reversao a mais do legado": a forma de 2000017792822486, a
-- contraprova de 2000018206306064, o empate de instante e o estorno do worker sem anulacao.
-- Escritos na correcao da reverificacao de cc90baa, rodaram verdes em `8504cd9` (integracao
-- 734/734, sessao principal, 2026-09-16 18:15 UTC). Depois dessa bateria entrou no mesmo bloco
-- a forma E >= 2 (V = 1, cancelamento e DUAS devolucoes depois do corte, R = 3): a devolucao
-- mais recente (1) e menor que o excesso (2), e e a unica forma que reprova sem o teto
-- `least(quantidade_reversao, ...)` da parte 1B -- nas outras E = 1.

create or replace temp view d351_organizacoes as
select g.organization_id,
       g.captured_at as corte_da_organizacao,
       a.sem_ajuste
       and coalesce(
         (select min(m.created_at) from public.stock_movements m where m.organization_id = g.organization_id),
         'infinity'::timestamptz
       ) > g.captured_at - interval '1 hour' as elegivel,
       -- Sem AJUSTE_RECONCILIACAO, elegivel ou nao: e onde o UPDATE de 20260916180000 corrige o
       -- corte, e onde a conferencia do corte do parse olha (reverificacao de 60c7a6a, BAIXA-1).
       a.sem_ajuste
from (
  select s.organization_id, max(s.captured_at) as captured_at
  from public.erp_stock_snapshots s
  group by s.organization_id
) g
cross join lateral (
  select not exists (
    select 1
    from public.stock_movements r
    where r.organization_id = g.organization_id
      and r.movement_type = 'AJUSTE_RECONCILIACAO'
  ) as sem_ajuste
) a
where nullif(current_setting('sb.compensacao_organizacao', true), '') is null
   or g.organization_id::text = current_setting('sb.compensacao_organizacao', true);

-- O corte proprio de cada SKU: o `max(captured_at)`, como `get_erp_stock_cutoffs`.
create or replace temp view d351_cortes as
select s.organization_id, s.sku_id, max(s.captured_at) as captured_at
from public.erp_stock_snapshots s
where s.sku_id is not null
group by s.organization_id, s.sku_id;

create or replace temp view d351_afetados as
select m.organization_id,
       m.sku_id,
       m.location_kind,
       m.qty_delta,
       m.source_type,
       m.source_id,
       m.idempotency_key,
       m.occurred_at,
       coalesce(k.captured_at, g.corte_da_organizacao) as corte,
       coalesce(o.date_closed, o.date_created) as venda_em,
       g.elegivel
from public.stock_movements m
join d351_organizacoes g on g.organization_id = m.organization_id
left join d351_cortes k on k.organization_id = m.organization_id and k.sku_id = m.sku_id
join public.orders o
  on o.organization_id = m.organization_id
 -- `source_id` e texto; o CASE impede o cast de uma origem que nao seja numero.
 and o.id = case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end
where m.movement_type = 'VENDA_ML'
  and m.source_type = 'ORDER'
  and coalesce(o.date_closed, o.date_created) <= coalesce(k.captured_at, g.corte_da_organizacao)
  -- A venda INTEIRA, mesmo com cancelamento E devolucao gravados (o legado de D-052/D-057): o
  -- excesso e anulado com a data da reversao, na parte 1B (D-351 §12).
  and not exists (
    select 1 from public.stock_movements e
    where e.idempotency_key = 'estorno:' || m.idempotency_key
  )
  and not exists (
    select 1 from public.stock_movements c
    where c.idempotency_key = 'cancelamento:' || m.idempotency_key
      and c.occurred_at <= coalesce(k.captured_at, g.corte_da_organizacao)
  );

-- PARTE 1B: as partes da reversao a mais de cada venda estornada que ainda nao tem anulacao.
create or replace temp view d351_excedentes as
select x.organization_id,
       x.sku_id,
       x.location_kind,
       x.qty_delta_venda,
       x.source_type,
       x.source_id,
       x.chave_venda,
       x.chave_reversao,
       x.occurred_at,
       x.elegivel,
       least(x.quantidade_reversao, greatest(0, x.excesso - x.posteriores)) as quantidade
from (
  select m.organization_id,
         m.sku_id,
         m.location_kind,
         m.qty_delta as qty_delta_venda,
         m.source_type,
         m.source_id,
         m.idempotency_key as chave_venda,
         r.idempotency_key as chave_reversao,
         r.occurred_at,
         r.qty_delta as quantidade_reversao,
         g.elegivel,
         sum(r.qty_delta) over (partition by m.id) - abs(m.qty_delta) as excesso,
         -- O que as reversoes MAIS RECENTES desta ja cederam: o excesso e delas primeiro. O
         -- desempate e o do dominio (ordem de codigo da chave), e o instante vai ao
         -- milissegundo, a precisao que o worker grava e compara.
         coalesce(sum(r.qty_delta) over (
           partition by m.id
           order by date_trunc('milliseconds', r.occurred_at) desc, r.idempotency_key collate "C" desc
           rows between unbounded preceding and 1 preceding
         ), 0) as posteriores
  from public.stock_movements m
  join d351_organizacoes g on g.organization_id = m.organization_id
  -- As reversoes desta venda, pelas duas causas: o cancelamento (origem do pedido, chave
  -- `cancelamento:<venda>`) e as devolucoes (origem do claim, pedido DENTRO da chave
  -- `devolucao:<claim>:<venda>` -- o indice de `20260916180400` atende o `split_part`).
  cross join lateral (
    select c.idempotency_key, c.qty_delta, c.occurred_at
      from public.stock_movements c
     where c.idempotency_key = 'cancelamento:' || m.idempotency_key
       and c.movement_type = 'CANCELAMENTO_ML'
    union all
    select d.idempotency_key, d.qty_delta, d.occurred_at
      from public.stock_movements d
     where d.organization_id = m.organization_id
       and d.movement_type = 'DEVOLUCAO_ML'
       and split_part(d.idempotency_key, ':', 4) = m.source_id
       and regexp_replace(d.idempotency_key, '^devolucao:[^:]+:', '') = m.idempotency_key
  ) r
  where m.movement_type = 'VENDA_ML'
    and m.source_type = 'ORDER'
    -- So venda estornada: sem o estorno, a venda nao e compensada, e o excesso fica como o
    -- legado o deixou (o mesmo que o worker faz).
    and exists (
      select 1 from public.stock_movements e
      where e.idempotency_key = 'estorno:' || m.idempotency_key
        and e.movement_type = 'ESTORNO_PRE_CAPTURA'
    )
) x
where least(x.quantidade_reversao, greatest(0, x.excesso - x.posteriores)) > 0
  and not exists (
    select 1 from public.stock_movements n
    where n.idempotency_key = 'estorno:' || x.chave_reversao
  );

create or replace temp view d351_reposicoes as
select r.*
from (
  select o.organization_id,
         coalesce(c.component_sku_id, i.sku_id) as sku_id,
         -(i.quantity * coalesce(c.quantity, 1)) as qty_delta,
         o.id::text as source_id,
         -- A MESMA chave do worker (`computeSaleDeductions`): KIT leva o componente.
         case when k.kind = 'KIT'
              then 'venda:' || o.id::text || ':' || i.position::text || ':' || c.component_sku_id::text
              else 'venda:' || o.id::text || ':' || i.position::text
         end as chave_venda,
         o.date_closed as venda_em,
         t.occurred_at as cancelado_em,
         coalesce(kc.captured_at, g.corte_da_organizacao) as corte,
         g.elegivel
  from public.orders o
  join d351_organizacoes g on g.organization_id = o.organization_id
  join lateral (
    select e.occurred_at
    from public.domain_events e
    where e.organization_id = o.organization_id
      and e.entity_type = 'order'
      and e.entity_id = o.id::text
      and e.event_type = 'order.cancelled'
      and e.before ->> 'status' in ('paid', 'partially_refunded')
    order by e.occurred_at desc
    limit 1
  ) t on true
  join public.order_items i on i.order_id = o.id and i.sku_id is not null
  join public.skus k on k.id = i.sku_id
  left join public.sku_components c on k.kind = 'KIT' and c.kit_sku_id = k.id
  left join d351_cortes kc
    on kc.organization_id = o.organization_id
   and kc.sku_id = coalesce(c.component_sku_id, i.sku_id)
  where o.status in ('cancelled', 'pending_cancel')
    and o.date_closed is not null
    -- KIT sem componente cadastrado nao deduz nada no worker; aqui tambem nao.
    and (k.kind <> 'KIT' or c.component_sku_id is not null)
) r
where r.venda_em <= r.corte
  and r.cancelado_em > r.corte
  -- NENHUM VENDA_ML do pedido, e nao "a chave de hoje nao foi gravada" (verificacao de
  -- e6fda07, MEDIA-1): a chave vem dos vinculos de HOJE, e com a composicao do KIT alterada,
  -- ou o PRODUTO virado KIT, a reposicao devolveria um SKU que nunca foi baixado.
  and not exists (
    select 1
    from public.stock_movements v
    where v.organization_id = r.organization_id
      and v.movement_type = 'VENDA_ML'
      and v.source_type = 'ORDER'
      and v.source_id = r.source_id
  );

do $$
declare
  v_corte_do_parse integer;
  v_gravados integer;
  v_anulacoes integer;
  v_vendas integer;
  v_estornos integer;
  v_cancelamentos integer;
  v_restantes integer;
  v_divergencias integer;
  r record;
begin
  -- PRE-REQUISITO 1, conferido: o corte ja e a exportacao em TODA organizacao sem
  -- AJUSTE_RECONCILIACAO -- as mesmas que o UPDATE de 20260916180000 corrige. A reconciliada
  -- fica com o corte do parse DE PROPOSITO (verificacao de e6fda07) e nao e compensada aqui.
  -- Nao so nas elegiveis (reverificacao de 60c7a6a, BAIXA-1): a planilha importada pelo worker
  -- antigo entre a migration e o deploy leva o corte da organizacao para o parse dela, e a de
  -- producao deixa de ser elegivel -- olhando so as elegiveis, a F3 pularia em silencio, em vez
  -- de parar.
  select count(*) into v_corte_do_parse
  from public.erp_stock_snapshots s
  join public.erp_import_batches b on b.id = s.batch_id
  join d351_organizacoes g on g.organization_id = s.organization_id and g.sem_ajuste
  where b.kind = 'STOCK'
    and b.parsed_at is not null
    and s.captured_at = b.parsed_at
    and private.erp_stock_export_instant(b.file_name, b.parsed_at) <> b.parsed_at;

  if v_corte_do_parse > 0 then
    raise exception 'compensacao_d351: % snapshots ainda com o corte do PARSE, e nao o da exportacao -- rode de novo o UPDATE de 20260916180000_erp_corte_da_exportacao antes da F3 (cabecalho, PRE-REQUISITO 1)',
      v_corte_do_parse;
  end if;

  for r in
    select x.organization_id, sum(x.afetados) as afetados, sum(x.reposicoes) as reposicoes, sum(x.excedentes) as excedentes
    from (
      select a.organization_id, count(*) as afetados, 0 as reposicoes, 0 as excedentes from d351_afetados a where not a.elegivel group by 1
      union all
      select p.organization_id, 0, count(*), 0 from d351_reposicoes p where not p.elegivel group by 1
      union all
      select e.organization_id, 0, 0, count(*) from d351_excedentes e where not e.elegivel group by 1
    ) x
    group by x.organization_id
  loop
    raise notice 'compensacao_d351: organizacao % fora do criterio (tem AJUSTE_RECONCILIACAO ou ledger anterior ao corte) com % VENDA_ML afetados, % vendas a repor e % reversoes a mais sem anulacao -- NAO compensada',
      r.organization_id, r.afetados, r.reposicoes, r.excedentes;
  end loop;

  -- PARTE 1.
  insert into public.stock_movements
    (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
  select a.organization_id,
         a.sku_id,
         a.location_kind,
         -a.qty_delta,
         'ESTORNO_PRE_CAPTURA',
         a.source_type,
         a.source_id,
         'estorno:' || a.idempotency_key,
         a.occurred_at
  from d351_afetados a
  where a.elegivel
  on conflict (idempotency_key) do nothing;

  get diagnostics v_gravados = row_count;

  raise notice 'compensacao_d351: % estornos gravados', v_gravados;

  -- PARTE 1B, depois da parte 1: a view le os estornos que ela acabou de gravar.
  insert into public.stock_movements
    (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
  select e.organization_id,
         e.sku_id,
         e.location_kind,
         sign(e.qty_delta_venda) * e.quantidade,
         'ESTORNO_REVERSAO_EXCEDENTE',
         e.source_type,
         e.source_id,
         'estorno:' || e.chave_reversao,
         e.occurred_at
  from d351_excedentes e
  where e.elegivel
  on conflict (idempotency_key) do nothing;

  get diagnostics v_anulacoes = row_count;

  raise notice 'compensacao_d351: % anulacoes de reversao a mais gravadas', v_anulacoes;

  -- PARTE 2: o trio num comando so -- as tres insercoes leem a MESMA selecao.
  with a_repor as (
    select * from d351_reposicoes where elegivel
  ),
  vendas as (
    insert into public.stock_movements
      (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
    select p.organization_id, p.sku_id, 'LOCAL', p.qty_delta, 'VENDA_ML', 'ORDER', p.source_id, p.chave_venda, p.venda_em
    from a_repor p
    on conflict (idempotency_key) do nothing
    returning 1
  ),
  estornos as (
    insert into public.stock_movements
      (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
    select p.organization_id, p.sku_id, 'LOCAL', -p.qty_delta, 'ESTORNO_PRE_CAPTURA', 'ORDER', p.source_id,
           'estorno:' || p.chave_venda, p.venda_em
    from a_repor p
    on conflict (idempotency_key) do nothing
    returning 1
  ),
  cancelamentos as (
    insert into public.stock_movements
      (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
    select p.organization_id, p.sku_id, 'LOCAL', -p.qty_delta, 'CANCELAMENTO_ML', 'ORDER', p.source_id,
           'cancelamento:' || p.chave_venda, p.cancelado_em
    from a_repor p
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select (select count(*) from vendas), (select count(*) from estornos), (select count(*) from cancelamentos)
    into v_vendas, v_estornos, v_cancelamentos;

  -- Um trio pela metade seria +1 ou -1 no saldo: um estorno ou cancelamento ja existente
  -- sem a venda e estado que nenhum produtor gera, e aborta em vez de seguir.
  if v_estornos <> v_vendas or v_cancelamentos <> v_vendas then
    raise exception 'compensacao_d351: reposicao incompleta -- % vendas, % estornos, % cancelamentos',
      v_vendas, v_estornos, v_cancelamentos;
  end if;

  raise notice 'compensacao_d351: % vendas repostas (venda + estorno + cancelamento)', v_vendas;

  -- PROVA 1, dentro do bloco: nada afetado sem par, nada a repor e nenhuma reversao a mais sem
  -- anulacao nas organizacoes elegiveis.
  select (select count(*) from d351_afetados a where a.elegivel)
       + (select count(*) from d351_reposicoes p where p.elegivel)
       + (select count(*) from d351_excedentes e where e.elegivel)
    into v_restantes;

  if v_restantes > 0 then
    raise exception 'compensacao_d351: % VENDA_ML afetados, vendas a repor ou reversoes a mais continuam pendentes', v_restantes;
  end if;

  -- PROVA 2: o ledger bate com a projecao, por SKU e local, nas organizacoes elegiveis.
  select count(*) into v_divergencias
  from (
    select l.quantidade, b.quantity
    from (
      select m.organization_id, m.sku_id, m.location_kind, sum(m.qty_delta) as quantidade
      from public.stock_movements m
      join d351_organizacoes g on g.organization_id = m.organization_id and g.elegivel
      group by m.organization_id, m.sku_id, m.location_kind
    ) l
    full join (
      select b.organization_id, b.sku_id, b.location_kind, b.quantity
      from public.inventory_balances b
      join d351_organizacoes g on g.organization_id = b.organization_id and g.elegivel
    ) b using (organization_id, sku_id, location_kind)
    where coalesce(l.quantidade, 0) <> coalesce(b.quantity, 0)
  ) d;

  if v_divergencias > 0 then
    raise exception 'compensacao_d351: % divergencias entre ledger e inventory_balances', v_divergencias;
  end if;
end;
$$;

-- PROVAS DEPOIS DE APLICAR (separadas; rodar e ler):
--
-- 1. pendentes, TODAS as organizacoes (esperado 0 na de producao):
--      select organization_id, elegivel, count(*) from d351_afetados group by 1, 2;
--      select organization_id, elegivel, count(*) from d351_reposicoes group by 1, 2;
--      select organization_id, elegivel, count(*) from d351_excedentes group by 1, 2;
--    (as views sao temporarias: rode este arquivo e as consultas na mesma sessao, ou recrie
--    as views antes.)
-- 2. reexecutar este arquivo: NOTICE "0 estornos gravados", "0 anulacoes de reversao a mais
--    gravadas" e "0 vendas repostas".
-- 3. repetir a prova 1 depois de 1 h e de 24 h.
