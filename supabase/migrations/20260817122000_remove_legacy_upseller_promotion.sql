-- The resumable state machine fully replaces the statement-timeout-prone RPC.
drop function if exists public.promote_upseller_import(uuid);

