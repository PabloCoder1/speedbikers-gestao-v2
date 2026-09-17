-- D-352 F3 -- compensacao do que o worker antigo gravou para vendas ENTREGUES PELO FULL.
--
-- NAO E MIGRATION, de proposito, pelas mesmas duas razoes da F3 da D-351
-- (`compensacao-estorno-pre-captura-d351.sql`): precisa rodar DEPOIS do deploy do worker
-- de D-352 -- enquanto o worker antigo estiver no ar ele continua gravando VENDA_ML de
-- pedido do Full sem par -- e a selecao e por REGRA, entao rodar de novo pega o que tiver
-- sobrado (e idempotente). Se virar migration, copie este corpo para um arquivo com
-- instante valido.
--
-- O QUE ESTA ERRADO HOJE. A unidade que o Mercado Livre despachou do galpao DELE nunca foi
-- da loja, e baixa-la do saldo LOCAL inventa uma saida. Medido em producao em 2026-09-17
-- (so SELECT): 2.667 `VENDA_ML` sem par de estorno, 2.768 unidades, 2.550 pedidos, TODOS
-- com `shipping_id`; 66 SKUs terminam com alvo LOCAL negativo, somando -406.
--
-- PRE-REQUISITOS
--   1. migration `20260918000000_estorno_full_e_logistica_do_pedido` aplicada -- o tipo
--      `ESTORNO_FULL` no CHECK e as colunas `orders.logistic_type`/`logistic_captured_at`.
--      CONFERIDO no bloco: sem elas, aborta antes de escrever qualquer coisa;
--   2. worker de D-352 servindo trafego (`sync.order-logistics` registrado);
--   3. **varredura `v3-order-logistics-sweep` CONCLUIDA**: o `logistic_type` e o unico
--      sinal que este arquivo le, e pedido sem ele nao entra em lugar nenhum. O bloco
--      NAO aborta por pendencia -- um envio que o Mercado Livre nao devolve travaria a
--      correcao dos outros 2.549 pedidos --, mas EMITE NOTICE com quantos pedidos
--      continuam sem decisao. Zero ali e a prova de que a varredura terminou;
--   4. `v3-reconcile-balances` AINDA pausado -- como na F3 da D-351, a organizacao que ja
--      reconciliou nao e compensada (ver "QUAIS ORGANIZACOES"), e despausar antes tiraria a
--      de producao da lista.
--
-- A CHAVE e NEUTRA: `estorno:<chave do movimento estornado>`, a mesma do worker
-- (`estornoKeyOf` em `@sb/domain`). O tipo diz a causa, a chave diz o movimento: um segundo
-- estorno do mesmo movimento, de qualquer produtor, cai no UNIQUE.
--
-- PARTE 1 -- `VENDA_ML` de pedido do Full gravado sem par (a regra do worker,
--   `computeSaleDeductions` + `fullEstornoOf`):
--   afetado = `VENDA_ML` de pedido com `orders.logistic_type = 'fulfillment'` que ainda nao
--             tem `estorno:<chave>`.
--   estorno = `ESTORNO_FULL` com quantidade OPOSTA e `occurred_at` ESPELHADO do `VENDA_ML` --
--             o par soma zero no saldo E no alvo de `compute_erp_target_balances` (as duas
--             linhas ficam do mesmo lado do corte). `created_by` nulo: linha de sistema.
--   SEM GATE DE CORTE, ao contrario da F3 da D-351. Aquela pergunta "a planilha do UpSeller
--             ja tinha descontado esta venda?"; esta pergunta "esta venda saiu do galpao do
--             Mercado Livre?". A segunda nao tem excecao de data: a unidade nunca foi da
--             loja, entao a baixa e errada em qualquer lado do corte.
--   A venda que JA tem `ESTORNO_PRE_CAPTURA` nao ganha um segundo estorno -- um estorno por
--             venda, nunca dois (precedencia da D-351, `computeSaleDeductions`). Ela ja soma
--             zero; o que falta nela e a parte 2.
--
-- PARTE 2 -- a reversao de pedido do Full, anulada INTEIRA (R3):
--   Numa venda que nunca saiu da loja, toda unidade devolvida a loja e excesso -- nao so a
--   que passou da quantidade vendida (o caso D-351 §12, `excessReversalShares`). A conta, com
--   V vendido e R revertido, tem de dar ZERO: `-V + V (estorno) + R - R (estas anulacoes)`.
--   No alvo tambem, porque cada par (venda, estorno) e (reversao, anulacao) cai do MESMO lado
--   do corte: a anulacao espelha o `occurred_at` da reversao, como em D-351 §12.
--   afetado = `CANCELAMENTO_ML` (origem do pedido, chave `cancelamento:<venda>`) e
--             `DEVOLUCAO_ML` (origem do CLAIM, pedido DENTRO da chave
--             `devolucao:<claim>:<venda>`) de venda ESTORNADA de pedido do Full -- pelo
--             `ESTORNO_FULL` da parte 1 ou pelo `ESTORNO_PRE_CAPTURA` que ja estava la.
--   anulacao = `ESTORNO_REVERSAO_EXCEDENTE` com a quantidade INTEIRA da reversao, o sinal, o
--             SKU, o local e a origem da VENDA, a chave neutra `estorno:<chave da reversao>`
--             e o `occurred_at` ESPELHADO da reversao. O tipo e a chave sao os MESMOS da
--             parte 1B da D-351, e e por isso que o UNIQUE absorve a anulacao que ela ja
--             tinha gravado para a mesma reversao.
--
-- RESIDUO DECLARADO -- a anulacao PARCIAL que a D-351 ja gravou.
--   A parte 1B da D-351 anula so o EXCESSO (`E = R - V`), e usa a MESMA chave
--   `estorno:<chave da reversao>`. Numa reversao de pedido do Full que ja recebeu essa
--   anulacao parcial, o UNIQUE impede a anulacao inteira: sobram `R - E = min(R, V)`
--   unidades a mais no saldo, o lado ALTO. Nao ha como gravar a diferenca sem uma segunda
--   chave para o mesmo movimento -- exatamente o que a chave neutra existe para impedir
--   (duas chaves deixariam DOIS estornos do mesmo movimento entrarem).
--   Este arquivo nao inventa uma saida: ele DECLARA o caso em NOTICE, com o pedido, a
--   reversao e quanto falta, e a assercao final exclui esses pedidos -- em vez de abortar a
--   correcao dos outros por causa deles, ou de passar por cima em silencio. Universo medido
--   da parte 1B em producao (2026-09-16): 20 `VENDA_ML` com excesso em 18 pedidos, todas com
--   V = 1, R = 2 e E = 1. Quantos desses 18 sao do Full so se sabe depois da varredura.
--   NOTA: a PARTE 1 nao tem esse risco. A anulacao da D-351 (F3 ou worker) so existe para
--   venda ESTORNADA, e a parte 1 so pega venda SEM estorno.
--
-- QUAIS ORGANIZACOES. So a que NUNCA RECONCILIOU -- nenhum `AJUSTE_RECONCILIACAO` e nenhuma
--   rodada `maintenance.reconcile-balances` concluida em `job_runs` (as duas fontes de
--   `reconciled_at` em `get_erp_stock_cutoffs`; a rodada que nao gravou ajuste nenhum TAMBEM
--   alinhou o saldo). Em producao (2026-09-17): zero ajustes e o job pausado desde D-350, entao
--   nada do universo medido fica de fora.
--
--   **Por que a reconciliacao muda a resposta, mesmo o Full nao dependendo de corte nenhum.**
--   A venda do Full com `occurred_at` DEPOIS do corte esta nos dois lados: o saldo tem o -V e o
--   alvo (`compute_erp_target_balances` soma `occurred_at > captured_at`) tambem -- sao os 66
--   SKUs com alvo LOCAL negativo. O par (venda, estorno) sobe os dois JUNTOS e a conta fecha.
--   Com a venda ATE o corte e um lado so: o alvo e o snapshot (nao a conta), o saldo tem o -V,
--   e uma reconciliacao ja forcou saldo = alvo = snapshot -- ou seja, o saldo JA esta certo.
--   Gravar o estorno ali deixaria o saldo em snapshot + V, e a rodada seguinte tiraria de novo.
--   E o mesmo raciocinio de `estornaVendaGravada` (D-351): quem absorve a venda gravada e o
--   ALINHAMENTO do saldo, nao o corte. Sem reconciliacao nenhuma nada absorveu nada, e o
--   estorno so aproxima o saldo do alvo.
--
--   Organizacao com afetados que fica de fora sai em NOTICE -- nunca some em silencio. Se
--   alguem despausar a reconciliacao antes desta compensacao, a organizacao deixa de ser
--   elegivel e este arquivo vira no-op: rode a PROVA 1 e leia o NOTICE.
--   Para restringir a UMA organizacao (e o que o teste de integracao faz):
--       begin;
--       set local sb.compensacao_organizacao = '<uuid>';
--       <este arquivo>
--       commit;
--
-- COMO RODAR: por psql, como postgres -- o SQL Editor do Supabase nao mostra os NOTICE, e sao
-- eles que dizem quantos estornos e anulacoes entraram, quantos pedidos continuam sem decisao
-- e qual reversao ficou de residuo
-- (`psql "$URL" -v ON_ERROR_STOP=1 -f compensacao-estorno-full-d352.sql`). O bloco e atomico e
-- termina com assercoes que abortam tudo se falharem.
--
-- COMO FOI PROVADO: `packages/db/src/estoque-full.integration.test.ts`, contra Postgres real --
-- compensa so o pedido do Full (e nao o `cross_docking` nem o sem sinal), espelha a data, o
-- alvo fecha em snapshot, a segunda execucao grava 0, a organizacao ja reconciliada NAO e
-- tocada e sai em NOTICE, a venda que ja tinha `ESTORNO_PRE_CAPTURA` nao ganha um segundo
-- estorno mas ganha a anulacao da reversao, e a anulacao parcial da D-351 sai como residuo
-- declarado em vez de furar a assercao.

-- As organizacoes com pedido do Full, e se cada uma pode ser compensada (nunca reconciliou).
create or replace temp view d352_organizacoes as
select o.organization_id,
       not exists (
         select 1 from public.stock_movements r
         where r.organization_id = o.organization_id
           and r.movement_type = 'AJUSTE_RECONCILIACAO'
       )
       and not exists (
         select 1 from public.job_runs j
         where j.organization_id = o.organization_id
           and j.job_type = 'maintenance.reconcile-balances'
           and j.status = 'done'
       ) as elegivel
from (select distinct organization_id from public.orders where logistic_type = 'fulfillment') o
where nullif(current_setting('sb.compensacao_organizacao', true), '') is null
   or o.organization_id::text = current_setting('sb.compensacao_organizacao', true);

-- Os pedidos do Full das organizacoes ELEGIVEIS. As inelegiveis saem por NOTICE no bloco.
create or replace temp view d352_pedidos as
select o.id,
       o.organization_id
from public.orders o
join d352_organizacoes g on g.organization_id = o.organization_id and g.elegivel
where o.logistic_type = 'fulfillment';

-- PARTE 1: `VENDA_ML` de pedido do Full sem par de estorno.
create or replace temp view d352_afetados as
select m.organization_id,
       m.sku_id,
       m.location_kind,
       m.qty_delta,
       m.source_type,
       m.source_id,
       m.idempotency_key,
       m.occurred_at
from public.stock_movements m
join d352_pedidos p
  on p.organization_id = m.organization_id
 -- `source_id` e texto; o CASE impede o cast de uma origem que nao seja numero.
 and p.id = case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end
where m.movement_type = 'VENDA_ML'
  and m.source_type = 'ORDER'
  and not exists (
    select 1 from public.stock_movements e
    where e.idempotency_key = 'estorno:' || m.idempotency_key
  );

-- Toda reversao gravada de venda ESTORNADA de pedido do Full, com os dados da venda que a
-- anulacao herda (SKU, local, origem e sinal). A view le os estornos que a parte 1 acabou de
-- gravar -- por isso ela e consultada DEPOIS dela.
create or replace temp view d352_reversoes as
select m.organization_id,
       m.sku_id,
       m.location_kind,
       m.qty_delta as qty_delta_venda,
       m.source_type,
       m.source_id,
       m.idempotency_key as chave_venda,
       r.idempotency_key as chave_reversao,
       r.qty_delta as quantidade_reversao,
       r.occurred_at,
       -- Quanto a anulacao ja gravada (a parcial da D-351 §12, quando houver) cobre.
       coalesce(
         (select abs(n.qty_delta) from public.stock_movements n
           where n.idempotency_key = 'estorno:' || r.idempotency_key),
         0
       ) as ja_anulado,
       exists (
         select 1 from public.stock_movements n
         where n.idempotency_key = 'estorno:' || r.idempotency_key
       ) as tem_anulacao
from public.stock_movements m
join d352_pedidos p
  on p.organization_id = m.organization_id
 and p.id = case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end
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
  -- So venda ANULADA: sem o estorno, a reversao dela e legitima e o par venda/reversao ja
  -- soma o que tem de somar. As duas causas valem (`ESTORNO_FULL` da parte 1 e
  -- `ESTORNO_PRE_CAPTURA` que ja estava la).
  and exists (
    select 1 from public.stock_movements e
    where e.idempotency_key = 'estorno:' || m.idempotency_key
      and e.movement_type in ('ESTORNO_FULL', 'ESTORNO_PRE_CAPTURA')
  );

-- PARTE 2: as reversoes que ainda nao tem NENHUMA anulacao -- estas sao anuladas INTEIRAS.
create or replace temp view d352_a_anular as
select * from d352_reversoes where not tem_anulacao;

-- RESIDUO: a reversao cuja anulacao ja gravada cobre MENOS que ela (a parcial da D-351 §12).
-- O UNIQUE da chave neutra impede completar, e a diferenca fica declarada.
create or replace temp view d352_residuo as
select * from d352_reversoes where tem_anulacao and ja_anulado < quantidade_reversao;

do $$
declare
  v_colunas integer;
  v_tipo integer;
  v_sem_decisao integer;
  v_estornos integer;
  v_anulacoes integer;
  v_restantes integer;
  v_divergencias integer;
  v_desbalanceados integer;
  r record;
begin
  -- PRE-REQUISITO 1: as duas portas da migration. Sem elas o script escreveria pela metade
  -- (a parte 1 falharia no CHECK) ou nem chegaria a selecionar nada.
  select count(*) into v_colunas
  from information_schema.columns
  where table_schema = 'public' and table_name = 'orders'
    and column_name in ('logistic_type', 'logistic_captured_at');

  if v_colunas <> 2 then
    raise exception 'compensacao_d352: orders sem logistic_type/logistic_captured_at (% de 2) -- aplique a migration 20260918000000 antes (cabecalho, PRE-REQUISITO 1)',
      v_colunas;
  end if;

  select count(*) into v_tipo
  from pg_constraint
  where conname = 'stock_movements_movement_type_check'
    and pg_get_constraintdef(oid) like '%ESTORNO_FULL%';

  if v_tipo <> 1 then
    raise exception 'compensacao_d352: o CHECK de stock_movements.movement_type ainda nao aceita ESTORNO_FULL -- aplique a migration 20260918000000 antes (cabecalho, PRE-REQUISITO 1)';
  end if;

  -- PRE-REQUISITO 3, declarado e NAO fatal: quantos pedidos com venda sem estorno continuam
  -- sem o sinal. Zero = a varredura terminou e esta rodada cobre o universo inteiro.
  select count(distinct m.source_id) into v_sem_decisao
  from public.stock_movements m
  join public.orders o
    on o.organization_id = m.organization_id
   and o.id = case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end
  where m.movement_type = 'VENDA_ML'
    and m.source_type = 'ORDER'
    and o.logistic_captured_at is null
    and (nullif(current_setting('sb.compensacao_organizacao', true), '') is null
         or o.organization_id::text = current_setting('sb.compensacao_organizacao', true))
    and not exists (
      select 1 from public.stock_movements e
      where e.idempotency_key = 'estorno:' || m.idempotency_key
    );

  if v_sem_decisao > 0 then
    raise notice 'compensacao_d352: % pedido(s) com VENDA_ML sem estorno continuam SEM o sinal da logistica -- a varredura v3-order-logistics-sweep ainda nao terminou, e eles NAO sao compensados nesta rodada (cabecalho, PRE-REQUISITO 3)',
      v_sem_decisao;
  else
    raise notice 'compensacao_d352: nenhum pedido pendente do sinal -- a varredura cobriu o universo';
  end if;

  -- A organizacao que ja reconciliou fica de fora, mas NUNCA em silencio: o que ela teria
  -- a compensar sai aqui, com o numero, para o dono decidir.
  for r in
    select g.organization_id, count(*) as afetados
    from d352_organizacoes g
    join public.orders o on o.organization_id = g.organization_id and o.logistic_type = 'fulfillment'
    join public.stock_movements m
      on m.organization_id = g.organization_id
     and m.movement_type = 'VENDA_ML'
     and m.source_type = 'ORDER'
     and case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end = o.id
    where not g.elegivel
      and not exists (
        select 1 from public.stock_movements e
        where e.idempotency_key = 'estorno:' || m.idempotency_key
      )
    group by g.organization_id
  loop
    raise notice 'compensacao_d352: organizacao % ja reconciliou (AJUSTE_RECONCILIACAO ou job_runs) e tem % VENDA_ML do Full sem par -- NAO compensada (cabecalho, QUAIS ORGANIZACOES)',
      r.organization_id, r.afetados;
  end loop;

  -- PARTE 1.
  insert into public.stock_movements
    (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
  select a.organization_id,
         a.sku_id,
         a.location_kind,
         -a.qty_delta,
         'ESTORNO_FULL',
         a.source_type,
         a.source_id,
         'estorno:' || a.idempotency_key,
         a.occurred_at
  from d352_afetados a
  on conflict (idempotency_key) do nothing;

  get diagnostics v_estornos = row_count;

  raise notice 'compensacao_d352: % estornos de venda do Full gravados', v_estornos;

  -- PARTE 2, depois da parte 1: a view le os estornos que ela acabou de gravar.
  insert into public.stock_movements
    (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
  select x.organization_id,
         x.sku_id,
         x.location_kind,
         -- O sinal da VENDA: a reversao devolveu unidade, a anulacao a tira de novo.
         sign(x.qty_delta_venda) * x.quantidade_reversao,
         'ESTORNO_REVERSAO_EXCEDENTE',
         x.source_type,
         x.source_id,
         'estorno:' || x.chave_reversao,
         x.occurred_at
  from d352_a_anular x
  on conflict (idempotency_key) do nothing;

  get diagnostics v_anulacoes = row_count;

  raise notice 'compensacao_d352: % reversoes de pedido do Full anuladas inteiras', v_anulacoes;

  -- RESIDUO, declarado linha a linha: a anulacao parcial da D-351 que o UNIQUE impede completar.
  for r in select * from d352_residuo loop
    raise notice 'compensacao_d352: RESIDUO -- pedido %, reversao % de % un. ja tem anulacao parcial de % un. (D-351 §12); faltam % un. e a chave neutra impede uma segunda anulacao -- decisao do dono',
      r.source_id, r.chave_reversao, r.quantidade_reversao, r.ja_anulado, r.quantidade_reversao - r.ja_anulado;
  end loop;

  -- PROVA 1: nada afetado sem par e nenhuma reversao de pedido do Full sem anulacao.
  select (select count(*) from d352_afetados)
       + (select count(*) from d352_a_anular)
    into v_restantes;

  if v_restantes > 0 then
    raise exception 'compensacao_d352: % vendas sem estorno ou reversoes sem anulacao continuam pendentes', v_restantes;
  end if;

  -- PROVA 2: o ledger bate com a projecao, por SKU e local, nas organizacoes tocadas.
  select count(*) into v_divergencias
  from (
    select l.quantidade, b.quantity
    from (
      select m.organization_id, m.sku_id, m.location_kind, sum(m.qty_delta) as quantidade
      from public.stock_movements m
      where exists (select 1 from d352_pedidos p where p.organization_id = m.organization_id)
      group by m.organization_id, m.sku_id, m.location_kind
    ) l
    full join (
      select b.organization_id, b.sku_id, b.location_kind, b.quantity
      from public.inventory_balances b
      where exists (select 1 from d352_pedidos p where p.organization_id = b.organization_id)
    ) b using (organization_id, sku_id, location_kind)
    where coalesce(l.quantidade, 0) <> coalesce(b.quantity, 0)
  ) d;

  if v_divergencias > 0 then
    raise exception 'compensacao_d352: % divergencias entre ledger e inventory_balances', v_divergencias;
  end if;

  -- PROVA 3 -- a que fecha o desenho: **o pedido do Full contribui ZERO para o LOCAL**.
  -- Nao e "o alvo nao ficou negativo": e a razao pela qual ele nao pode ficar. Se cada
  -- pedido do Full soma zero, ele nao tira nem poe unidade no saldo NEM no alvo (as linhas
  -- do par caem do mesmo lado do corte de `compute_erp_target_balances`), e nenhum dos 66
  -- SKUs negativos continua negativo por causa do Full.
  -- Fora da conta: os pedidos do RESIDUO, onde a anulacao parcial da D-351 ocupou a chave.
  select count(*) into v_desbalanceados
  from (
    select p.id, sum(m.qty_delta) as saldo
    from d352_pedidos p
    join public.stock_movements m
      on m.organization_id = p.organization_id
     and m.location_kind = 'LOCAL'
     and (
       (m.source_type = 'ORDER'
         and case when m.source_id ~ '^[0-9]{1,18}$' then m.source_id::bigint end = p.id)
       -- A devolucao e gravada com a origem do CLAIM; o pedido so aparece na chave.
       or (m.movement_type = 'DEVOLUCAO_ML' and split_part(m.idempotency_key, ':', 4) = p.id::text)
     )
    where not exists (select 1 from d352_residuo z where z.source_id = p.id::text)
    group by p.id
    having sum(m.qty_delta) <> 0
  ) x;

  if v_desbalanceados > 0 then
    raise exception 'compensacao_d352: % pedido(s) do Full com soma LOCAL diferente de zero -- a venda ainda esta baixando a loja', v_desbalanceados;
  end if;
end;
$$;

-- PROVAS DEPOIS DE APLICAR (separadas; rodar e ler):
--
-- 1. pendentes (esperado 0 nas duas):
--      select count(*) from d352_afetados;
--      select count(*) from d352_a_anular;
--    (as views sao temporarias: rode este arquivo e as consultas na mesma sessao, ou recrie
--    as views antes.)
-- 2. reexecutar este arquivo: NOTICE "0 estornos de venda do Full gravados" e "0 reversoes de
--    pedido do Full anuladas inteiras".
-- 3. o alvo LOCAL negativo, antes e depois -- os 66 SKUs / -406 medidos em 17/09 devem cair
--    para os que nao vem do Full (3 deles nao vem: 24008, 12152E e BFE-PTA, D-351 §13):
--      select count(*), sum(t.quantity)
--        from public.compute_erp_target_balances('<uuid da organizacao>') t
--       where t.location_kind = 'LOCAL' and t.quantity < 0;
-- 4. repetir a prova 1 depois de 1 h e de 24 h: a varredura continua rodando, e pedido que
--    recebeu o sinal depois desta execucao aparece aqui -- rode o arquivo de novo.
