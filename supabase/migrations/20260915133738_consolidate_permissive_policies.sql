-- Remove only policies whose predicates are exact duplicates of an ALL policy.
-- The remaining SELECT policies are intentionally retained for non-admin members.
drop policy if exists notification_preferences_select_own on public.notification_preferences;
