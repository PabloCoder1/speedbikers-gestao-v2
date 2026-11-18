/**
 * Texto digitado que vai dentro de um `.or()` do PostgREST. Vírgula e
 * parênteses quebram a sintaxe do filtro, e `%`, `*` e `\\` mudariam o padrão
 * do `ilike` — viram espaço. Mesma regra de `vinculacoes/busca-sku.tsx`, aqui
 * compartilhável (lote 3 do pente fino, 18/09).
 */
export function termoSeguroParaOr(valor: string): string {
  return valor.replace(/[,()%*\\]/g, " ").trim();
}

/** Preserva o valor literal de uma comparação dentro de `.or()`. */
export function valorLiteralParaOr(valor: string): string {
  return `"${valor.replace(/["\\]/g, "\\$&")}"`;
}
