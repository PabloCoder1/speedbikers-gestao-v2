import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@sb/db";

/**
 * A associação do usuário logado à organização — a linha DELE em
 * `organization_members` (D-232).
 *
 * A forma antiga, repetida em ~25 telas, era
 * `from("organization_members").select(...).maybeSingle()` sem filtro por
 * usuário. Funciona hoje por acidente de cardinalidade: a policy de SELECT
 * devolve TODOS os membros da organização, e só há um. No dia em que
 * `/usuarios` cadastrar o segundo, `maybeSingle()` devolve `PGRST116`
 * (mais de uma linha), `data` vira `null`, e a tela diz "sem organização" ou
 * "restrita a ADMIN" para o próprio ADMIN. A revisão adversarial de D-231
 * achou isso; as telas novas (`/integracoes`, `/configuracoes`) já leem por
 * aqui, e a migração das outras está registrada no HANDOFF.
 *
 * `error` é devolvido, não engolido: "não consegui ler" e "não é membro" são
 * respostas diferentes (D-067), e a tela decide o que dizer em cada uma.
 */
export interface CurrentMembership {
  organizationId: string | null;
  role: string | null;
  error: { message: string } | null;
}

export async function currentMembership(supabase: SupabaseClient<Database>): Promise<CurrentMembership> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;

  if (userId === null) {
    return { organizationId: null, role: null, error: null };
  }

  const membership = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  return {
    organizationId: membership.data?.organization_id ?? null,
    role: membership.data?.role ?? null,
    error: membership.error,
  };
}
