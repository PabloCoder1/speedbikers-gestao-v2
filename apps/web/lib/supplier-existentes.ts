import type { FornecedorExistente } from "./supplier-form-guia";
import type { createClient } from "./supabase/server";

/**
 * Os fornecedores da organização para o aviso de duplicado do formulário
 * (D-367). A RLS recorta a organização; a tabela é pequena (dezenas a poucas
 * centenas), e o teto só protege contra o caso patológico. Falha de leitura
 * vira lista vazia: sem o aviso, o formulário continua funcionando, e o banco
 * ainda recusa o nome idêntico.
 */
export async function lerExistentes(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<readonly FornecedorExistente[]> {
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, document, is_active")
    .order("name")
    .limit(2000);

  if (error !== null) return [];

  return data.map((f) => ({ id: f.id, name: f.name, document: f.document, isActive: f.is_active }));
}
