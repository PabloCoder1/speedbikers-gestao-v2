-- ============================================================
-- Speed Bikers Gestão V2
-- First access password change requirement
-- ============================================================

alter table public.profiles
add column must_change_password boolean not null default true;

comment on column public.profiles.must_change_password is
  'Indicates whether the user must define a permanent password before accessing the application normally.';