-- The 4 ETAPA 34 sales-orders RPCs are deliberately invoker-mode (not
-- security definer), so calling private.is_organization_member from
-- inside them executes with the CALLER's own privileges — unlike the
-- security-definer purchase-planning RPCs, where that same call always
-- ran as the function owner regardless of caller. private.is_organization_member
-- was only ever granted execute to `authenticated`, so a service_role
-- caller (used by the credentialed test suite, same
-- caller_role='service_role' bypass pattern used throughout) hit
-- "permission denied for function is_organization_member".
--
-- Safe to grant: service_role already bypasses RLS and has unrestricted
-- table access, so letting it call this read-only boolean helper adds
-- no new capability. Same reasoning as the pre-existing
-- "grant usage on schema private to service_role" fix.

grant execute on function private.is_organization_member(uuid) to service_role;
