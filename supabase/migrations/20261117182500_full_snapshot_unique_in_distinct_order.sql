-- ============================================================
-- D-720 — um índice só para a timeline do Full
--
-- `fulfillment_stock_snapshots` tinha dois índices com as mesmas três colunas:
--   * a constraint `fulfillment_stock_snapshots_unique`
--     (ml_account_id, inventory_id, captured_at), toda ASC;
--   * `fulfillment_stock_snapshots_timeline_idx`
--     (ml_account_id, inventory_id, captured_at DESC).
-- No backup de produção de 22/10, cada um tinha 19,5 MB, e toda captura do
-- Full escrevia nos dois.
--
-- A migration `20260928160000` deixou o `timeline_idx` de fora DE PROPÓSITO,
-- e o motivo continua certo: a varredura reversa da unique dá a ordem
-- DESC,DESC,DESC, e não a ordem mista (ASC, ASC, DESC) do
-- `distinct on (ml_account_id, inventory_id) ... order by captured_at desc`
-- que as nove funções do "Full atual" usam (D-465). Apagar só o
-- `timeline_idx` trocaria o plano por unique + sort incremental.
--
-- A saída é a unicidade NA ORDEM do `distinct on`: um índice unique
-- (ml_account_id, inventory_id, captured_at DESC). Ele garante a mesma
-- unicidade (a direção não muda a igualdade), serve a mesma ordem que o
-- `timeline_idx` servia e ocupa o lugar dos dois. Constraint de tabela
-- não aceita DESC, então a unicidade passa a ser um índice unique. O nome
-- `fulfillment_stock_snapshots_unique` fica, e nenhum código o cita
-- (`grep` em apps, packages e migrations, 17/11). O worker grava com
-- `insert` simples, e a colisão continua sendo erro 23505.
--
-- Lock: `create unique index` sem CONCURRENTLY (a migration roda em
-- transação) bloqueia as escritas da tabela enquanto constrói. Medido no
-- backup restaurado: ver docs/PERFORMANCE.md (D-720). A captura do Full é
-- um job da fila; se encostar no lock, espera, e o Cloud Tasks repete.
-- ============================================================

set local lock_timeout = '10s';

create unique index fulfillment_stock_snapshots_unique_desc
  on public.fulfillment_stock_snapshots (ml_account_id, inventory_id, captured_at desc);

alter table public.fulfillment_stock_snapshots
  drop constraint fulfillment_stock_snapshots_unique;

drop index public.fulfillment_stock_snapshots_timeline_idx;

alter index public.fulfillment_stock_snapshots_unique_desc
  rename to fulfillment_stock_snapshots_unique;

comment on index public.fulfillment_stock_snapshots_unique is
  'Uma captura por inventario e instante, na ordem do distinct on do Full atual (D-720): substitui a constraint ASC e o timeline_idx DESC.';

-- A prova, dentro da migration: a unicidade continua de pé e é a única
-- indexação por (conta, inventário, instante).
do $prova$
declare
  v_indices integer;
begin
  select count(*) into v_indices
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where i.indrelid = 'public.fulfillment_stock_snapshots'::regclass
    and i.indkey::text = (
      select string_agg(a.attnum::text, ' ' order by k.o)
      from unnest(array['ml_account_id', 'inventory_id', 'captured_at']) with ordinality k(n, o)
      join pg_attribute a on a.attrelid = 'public.fulfillment_stock_snapshots'::regclass and a.attname = k.n
    );

  if v_indices <> 1 then
    raise exception 'D-720: esperava um indice em (ml_account_id, inventory_id, captured_at), achei %', v_indices;
  end if;

  if not exists (
    select 1 from pg_index
    where indexrelid = 'public.fulfillment_stock_snapshots_unique'::regclass and indisunique
  ) then
    raise exception 'D-720: fulfillment_stock_snapshots_unique nao e unique';
  end if;
end;
$prova$;
