/**
 * O recorte da `/vendas` do Mercado Livre lido da URL: a conta e a marca
 * (D-237). Morava dentro de `app/(app)/vendas/page.tsx`; saiu para cá quando o
 * CSV do recorte (D-602) passou a precisar da MESMA regra -- duas cópias
 * divergiriam no primeiro ajuste, e o arquivo deixaria de ser o que a tela mostra.
 */

/** Marca e "sem marca" são estados mutuamente exclusivos, por isso dois parâmetros na URL. */
export type FiltroDeMarca = { kind: "todas" } | { kind: "marca"; value: string } | { kind: "sem_marca" };

/** `semMarca=1` vence sobre `marca=` quando os dois vêm: o recorte mais específico. */
export function resolverMarcaDaVenda(query: Readonly<Record<string, unknown>>): FiltroDeMarca {
  if (query.semMarca === "1") return { kind: "sem_marca" };
  if (typeof query.marca === "string" && query.marca.trim() !== "") return { kind: "marca", value: query.marca.trim() };

  return { kind: "todas" };
}

/**
 * Os argumentos de marca das RPCs de vendas do ML. Com `exactOptionalPropertyTypes`,
 * o objeto vazio omite a chave em vez de mandar `undefined`.
 */
export function argumentosDaMarca(marca: FiltroDeMarca): { p_supplier_brand?: string; p_sem_marca?: boolean } {
  if (marca.kind === "marca") return { p_supplier_brand: marca.value };
  if (marca.kind === "sem_marca") return { p_sem_marca: true };

  return {};
}

/**
 * A conta pelo slug da URL. Slug desconhecido (conta removida, digitado à mão)
 * cai em "todas as contas" em silêncio -- não é erro de rede nem de dado.
 */
export function resolverContaDaVenda<T extends { readonly slug: string }>(
  query: Readonly<Record<string, unknown>>,
  contas: readonly T[],
): T | null {
  const pedido = typeof query.account === "string" ? query.account : null;

  return contas.find((conta) => conta.slug === pedido) ?? null;
}
