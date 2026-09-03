import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@sb/db";

/**
 * A associação do usuário logado à organização — a linha DELE em
 * `organization_members` (D-232, generalizado em D-234).
 *
 * A forma antiga, repetida em ~25 telas, era
 * `from("organization_members").select(...).maybeSingle()` sem filtro por
 * usuário. Funcionava por acidente de cardinalidade: a policy de SELECT é
 * `organization_id in (private.accessible_orgs())` e devolve TODOS os membros
 * da organização — só havia um. Medido com o segundo membro na mesma
 * organização, a forma antiga devolve `PGRST116` e `data` nulo, e a tela diz
 * "sem organização" **para o próprio ADMIN**.
 *
 * O filtro acontece no BANCO (`get_current_membership`), não aqui: fazer
 * `.eq("user_id", …)` exigiria `getUser()` antes da consulta, e `getUser()`
 * revalida o token contra o servidor de Auth — uma ida inteira, em série com a
 * segunda (a observação é da própria casa, em `components/shell.tsx`). Em ~25
 * telas isso seria latência nova em toda a aplicação.
 *
 * `error` é devolvido, não engolido: "não consegui ler" e "não é membro" são
 * respostas diferentes (D-067), e a tela decide o que dizer em cada uma.
 */
export interface CurrentMembership {
  organizationId: string | null;
  organizationName: string | null;
  role: string | null;
  error: { message: string } | null;
}

const SEM_MEMBRO: CurrentMembership = {
  organizationId: null,
  organizationName: null,
  role: null,
  error: null,
};

export async function currentMembership(supabase: SupabaseClient<Database>): Promise<CurrentMembership> {
  const { data, error } = await supabase.rpc("get_current_membership");

  if (error !== null) {
    return { ...SEM_MEMBRO, error };
  }

  // Depois da checagem de erro o PostgREST garante o array; sem `?? []` o
  // lint acusa a condição morta, e a condição morta esconde a leitura real.
  const linhas = data;

  if (linhas.length === 0) {
    return SEM_MEMBRO;
  }

  // Mais de uma organização é ESTADO NOMEADO, não "pegue a primeira".
  // `accessible_orgs()` é um conjunto, então isso é estruturalmente possível
  // (hoje nenhum usuário está em duas — medido). Escolher uma em silêncio
  // seria a mesma classe de erro que esta função conserta: a tela mostraria
  // dados de uma organização com o cabeçalho de outra. Enquanto não existir
  // seletor de organização, o honesto é dizer que não dá para decidir.
  if (linhas.length > 1) {
    return {
      ...SEM_MEMBRO,
      error: {
        message: `usuário pertence a ${String(linhas.length)} organizações e não há seletor de organização`,
      },
    };
  }

  const linha = linhas[0];

  return {
    organizationId: linha?.organization_id ?? null,
    organizationName: linha?.organization_name ?? null,
    role: linha?.role ?? null,
    error: null,
  };
}
