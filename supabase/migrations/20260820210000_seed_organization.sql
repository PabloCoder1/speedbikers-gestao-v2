-- ============================================================
-- Organizacao inicial: Speed Bikers.
--
-- Por que num migration e nao em `supabase/seed.sql`: `seed.sql` so roda no
-- `db reset` local. A CI aplica o schema em Dev com `db push`, que ignora o
-- seed. Sem isto, Dev teria o esquema de multi-tenant e nenhum tenant — e
-- toda tabela de dominio exige `organization_id` (D-031).
--
-- O UUID e FIXO de proposito. Ele aparece em teste, em script de carga e em
-- consulta manual; um valor sorteado por ambiente transformaria cada um desses
-- usos numa consulta previa.
--
-- Idempotente: `db push` pode reaplicar, e reaplicar nao pode duplicar tenant.
-- ============================================================

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-000000000001', 'Speed Bikers', 'speed-bikers')
on conflict (slug) do nothing;
