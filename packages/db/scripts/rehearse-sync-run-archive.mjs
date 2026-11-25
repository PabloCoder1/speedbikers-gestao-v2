#!/usr/bin/env node
// Ensaio manual de D04. Usa o catálogo do Supabase em um banco local vazio.
// A transação termina em ROLLBACK, incluindo papéis, triggers e fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
const connectionString = process.env.SUPABASE_DB_URL;
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const target = connectionString ? new URL(connectionString) : null;
if (target === null || !localHosts.has(target.hostname) || target.search !== "" ||
    !["postgres:", "postgresql:"].includes(target.protocol)) {
    throw new Error("SUPABASE_DB_URL precisa apontar para um Supabase local descartável.");
}
const db = new Client({ connectionString });
const org = randomUUID();
const user = randomUUID();
const account = randomUUID();
const other = randomUUID();
const historical = randomUUID();
const latest = randomUUID();
const normal = randomUUID();
const claims = randomUUID();

const ddl = `
create role d04_mover nologin;
create role d04_hydrator nologin;
create role d04_operator nologin;
grant d04_mover,d04_hydrator,d04_operator to postgres;
create schema d04_probe;
create table d04_probe.allowed_scope (organization_id uuid, ml_account_id uuid, primary key (organization_id, ml_account_id));
grant select on d04_probe.allowed_scope to d04_mover;
create table d04_probe.cold (like public.sync_runs including defaults including constraints);
alter table d04_probe.cold add primary key (id);
grant usage on schema d04_probe to d04_mover,d04_hydrator,d04_operator;
grant create on schema d04_probe to d04_mover,d04_hydrator;
grant insert,select on d04_probe.cold to d04_mover;
grant select on d04_probe.cold to d04_hydrator;
grant select,delete on public.sync_runs to d04_mover;
grant select,insert on public.sync_runs to d04_hydrator;
grant update (id) on public.sync_runs to d04_mover,d04_hydrator;
grant select on public.sync_errors to d04_mover;
create policy d04_read on public.sync_runs for select to d04_mover,d04_hydrator using (true);
create policy d04_lock on public.sync_runs for update to d04_mover,d04_hydrator using (true) with check (false);
create policy d04_cut on public.sync_runs for delete to d04_mover using (true);
create policy d04_write on public.sync_runs for insert to d04_hydrator with check (true);
create policy d04_read_errors on public.sync_errors for select to d04_mover using (true);
create or replace function private.sync_runs_reject_mutation() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' and current_user='d04_mover' then return old; end if;
  raise exception 'sync_runs e append-only: % nao e permitido.',tg_op;
end;$$;
drop trigger sync_runs_aviso_de_parada on public.sync_runs;
create trigger sync_runs_aviso_de_parada after insert on public.sync_runs for each row
when (new.status='failed' and new.resource='orders' and new.channel='reconciliation' and current_user <> 'd04_hydrator')
execute function private.aviso_de_reconciliacao_parada();
create function d04_probe.move_one(p_org uuid,p_account uuid,p_id uuid,p_before timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$
declare picked public.sync_runs%rowtype;
begin
  if not exists (select from d04_probe.allowed_scope
    where (organization_id, ml_account_id) = (p_org, p_account)) then return false; end if;
  select * into picked from public.sync_runs where id=p_id and organization_id=p_org and ml_account_id=p_account and finished_at<p_before for update skip locked;
  if not found then return false; end if;
  if exists (select from public.sync_errors where sync_run_id=p_id) then return false; end if;
  if exists (
    with marks as (
      select max(finished_at) filter (where resource=picked.resource and channel=picked.channel) as last_run,
             max(finished_at) filter (where resource=picked.resource and channel=picked.channel and status in ('done','partial')) as last_success,
             max(latest_record_at) filter (where resource=picked.resource and channel=picked.channel and status in ('done','partial')) as watermark,
             max(finished_at) filter (where status='done') as card,
             max(latest_record_at) filter (where resource='claims') as claims_mark
        from public.sync_runs where organization_id=p_org and ml_account_id=p_account
    )
    select from marks where picked.finished_at=last_run
      or (picked.status in ('done','partial') and (picked.finished_at=last_success or picked.latest_record_at=watermark))
      or (picked.status='done' and picked.finished_at=card)
      or (picked.resource='claims' and picked.latest_record_at=claims_mark)
  ) then return false; end if;
  insert into d04_probe.cold select r.* from public.sync_runs r where r.id=p_id;
  delete from public.sync_runs where id=p_id;
  return found;
end;$$;
alter function d04_probe.move_one(uuid,uuid,uuid,timestamptz) owner to d04_mover;
revoke all on function d04_probe.move_one(uuid,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function d04_probe.move_one(uuid,uuid,uuid,timestamptz) to d04_operator;
create function d04_probe.ensure_run() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.sync_run_id is null then return new; end if;
  perform 1 from public.sync_runs r
    where (r.id,r.organization_id,r.ml_account_id)=(new.sync_run_id,new.organization_id,new.ml_account_id) for key share;
  if found then return new; end if;
  insert into public.sync_runs select a.* from d04_probe.cold a
    where (a.id,a.organization_id,a.ml_account_id)=(new.sync_run_id,new.organization_id,new.ml_account_id) on conflict (id) do nothing;
  perform 1 from public.sync_runs r
    where (r.id,r.organization_id,r.ml_account_id)=(new.sync_run_id,new.organization_id,new.ml_account_id) for key share;
  if not found then raise exception using errcode='23503',message='sync_run fora do escopo ou ausente'; end if;
  return new;
end;$$;
alter function d04_probe.ensure_run() owner to d04_hydrator;
revoke all on function d04_probe.ensure_run() from public,anon,authenticated,service_role;
create trigger d04_sync_error_parent before insert on public.sync_errors for each row execute function d04_probe.ensure_run();
revoke create on schema d04_probe from d04_mover,d04_hydrator;
`;
const date = '2026-09-07T12:00:00Z';
async function seed(id, status, finished, resource = 'orders') {
    await db.query(`insert into public.sync_runs(id,organization_id,ml_account_id,job_id,resource,channel,status,reason,started_at,finished_at,latest_record_at)
  values ($1,$2,$3,$4,$8,'reconciliation',$5,$6,$7::timestamptz-interval '1 minute',$7,case when $5='done' then $7::timestamptz end)`, [id, org, account, randomUUID(), status, status === 'failed' ? 'D04 fixture' : null, finished, resource]);
}
async function asRole(role, work) {
    await db.query("savepoint role_call");
    await db.query(`set local role ${role}`);
    try {
        return await work();
    } catch (error) {
        await db.query("rollback to role_call");
        throw error;
    } finally {
        await db.query("reset role");
        await db.query("release savepoint role_call");
    }
}

async function expectDenied(work, code) {
    await db.query("savepoint negative");
    try {
        await assert.rejects(work, { code });
    } finally {
        await db.query("rollback to negative");
        await db.query("release savepoint negative");
    }
}

async function snapshot() {
    return asRole('authenticated', async () => {
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })]);
        const health = await db.query('select * from public.get_sync_health($1) order by ml_account_id,resource,channel', [org]);
        const cards = await db.query('select id,last_sync_at from public.get_ml_account_cards($1) order by id', [org]);
        const orders = await db.query(`select latest_record_at,started_at from public.sync_runs where ml_account_id=$1 and resource='orders' and channel='reconciliation' and status in ('done','partial') order by finished_at desc limit 1`, [account]);
        const claims = await db.query(`select latest_record_at from public.sync_runs where ml_account_id=$1 and resource='claims' and latest_record_at is not null order by latest_record_at desc limit 1`, [account]);
        return { health: health.rows, cards: cards.rows, orders: orders.rows, claims: claims.rows };
    });
}
const error = (id, accountId) => db.query(`insert into public.sync_errors(organization_id,ml_account_id,sync_run_id,resource,error_class,message,occurred_at) values($1,$2,$3,'orders','retryable','D04 fixture',now())`, [org, accountId, id]);
const move = (accountId, id = historical, before = '2026-09-08T00:00:00Z') => asRole('d04_operator', () => db.query('select d04_probe.move_one($1,$2,$3,$4) moved', [org, accountId, id, before]));
async function watcher() {
    await db.query('savepoint probe_watch');
    try {
        const result = await db.query(`select private.avisar_sincronizacao_parada($1,'2026-09-09T00:00:00Z',null) as sent`, [account]);
        const events = await db.query(`select event_type,dedup_key,after from public.domain_events where organization_id=$1 and event_type in ('sync.failed','sync.delayed')`, [org]);
        return { sent: result.rows[0].sent, events: events.rows };
    }
    finally {
        await db.query('rollback to probe_watch');
        await db.query('release savepoint probe_watch');
    }
}
const alerts = async () => (await db.query(`select count(*)::int n from public.domain_events where organization_id=$1 and event_type in ('sync.failed','sync.delayed')`, [org])).rows[0].n;
async function rehearse() {
    await db.connect();
    try {
        await db.query("begin");
        await db.query("set local lock_timeout = '2s'");
        const { rows: [existing] } = await db.query(`select
          exists (select from auth.users)
          or exists (select from public.ml_accounts)
          or exists (select from public.sync_runs)
          or exists (select from public.sync_errors) as initialized`);
        if (existing.initialized) {
            throw new Error("O laboratório precisa ter o catálogo sem usuários, contas ou execuções.");
        }
        await db.query(ddl);
        await db.query("insert into auth.users(id,instance_id,aud,role,email,raw_user_meta_data) values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','d04-acl@invalid.test','{}')", [user]);
        await db.query("insert into public.organizations(id,name,slug) values($1,'D04 ACL','d04-acl')", [org]);
        await db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,'ADMIN')", [org, user]);
        await db.query(`insert into public.ml_accounts(id,organization_id,label,slug,seller_id,status,connected_at) values
    ($1,$3,'Principal','d04-acl-main',842313301,'CONNECTED','2026-09-01'),
    ($2,$3,'Outra','d04-acl-other',842313302,'CONNECTED','2026-09-01')`, [account, other, org]);
        await db.query("insert into d04_probe.allowed_scope values ($1, $2)", [org, account]);
        const { rows: [membership] } = await db.query(`select
          pg_has_role('service_role', 'd04_hydrator', 'MEMBER') as hydrator,
          pg_has_role('service_role', 'd04_mover', 'MEMBER') as mover`);
        assert.deepEqual(membership, { hydrator: false, mover: false });
        await db.query('alter table public.sync_runs disable trigger sync_runs_aviso_de_parada');
        await seed(historical, 'failed', date);
        await seed(latest, 'done', '2026-09-08T12:00:00Z');
        await seed(claims, 'done', '2026-09-07T10:00:00Z', 'claims');
        await db.query('alter table public.sync_runs enable trigger sync_runs_aviso_de_parada');
        assert.equal(await alerts(), 0);
        const baseline = await snapshot();
        assert.equal(baseline.health.length, 2);
        assert.equal(baseline.cards.length, 2);
        assert.equal(baseline.orders.length, 1);
        assert.equal(baseline.claims.length, 1);
        const watchBefore = await watcher();
        assert.equal(watchBefore.sent, true);
        assert.equal(watchBefore.events.length, 1);
        assert.equal((await move(account, latest, '2026-09-20T00:00:00Z')).rows[0].moved, false);
        assert.equal((await move(account, claims, '2026-09-20T00:00:00Z')).rows[0].moved, false);
        await expectDenied(() => asRole('d04_operator', () => db.query('delete from public.sync_runs where id=$1', [historical])), '42501');
        await expectDenied(() => asRole('d04_operator', () => db.query('select * from d04_probe.cold')), '42501');
        await expectDenied(() => asRole('service_role', () => db.query('select d04_probe.move_one($1,$2,$3,now())', [org, account, historical])), '42501');
        assert.equal((await move(other)).rows[0].moved, false);
        assert.equal((await move(account)).rows[0].moved, true);
        assert.deepEqual(await snapshot(), baseline);
        assert.deepEqual(await watcher(), watchBefore);
        await expectDenied(() => asRole('service_role', () => error(historical, other)), '23503');
        await expectDenied(() => asRole('service_role', () => error(randomUUID(), account)), '23503');
        await asRole('service_role', () => error(historical, account));
        assert.equal(await alerts(), 0);
        assert.deepEqual(await snapshot(), baseline);
        assert.deepEqual(await watcher(), watchBefore);
        assert.equal((await move(account)).rows[0].moved, false);
        await expectDenied(() => db.query('update public.sync_runs set reason=$2 where id=$1', [historical, 'bypass']), 'P0001');
        await asRole('service_role', () => seed(normal, 'failed', '2026-09-10T12:00:00Z'));
        assert.equal(await alerts(), 1);
        console.log('Papéis restritos, erro tardio sem alerta, alerta normal preservado, saúde, cartões e checkpoints equivalentes, vigia idêntico, corte de checkpoints recusado e UPDATE protegido.');
    }
    finally {
        await db.query('rollback');
        await db.end();
    }
}

rehearse().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
