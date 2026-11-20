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

/**
 * Escapa curingas literais do `LIKE`/`ILIKE` (`\`, `%`, `_`) para buscas por
 * trecho de código (ex.: SKUs com `_` ou `%`), sem alterar caracteres comuns.
 */
export function escaparIlike(valor: string): string {
  return valor.replace(/[\\%_]/g, "\\$&");
}

/**
 * Resolve o filtro de conta pedido na URL contra o resultado de `ml_accounts`,
 * falhando fechado quando o usuário pediu uma conta específica e a leitura de
 * contas falhou (evita descartar `?conta=` / `?account=` e expor dados de
 * todas as contas da organização).
 */
export function resolverContaSolicitada<
  T extends { id: string },
  E extends { message: string; code?: string } = { message: string; code?: string },
>(
  solicitada: string | null,
  leitura: { data: readonly T[] | null; error: E | null } | null,
  comparar: (conta: T, valor: string) => boolean = (conta, valor) => conta.id === valor,
): { conta: T | null; erro: E | { message: string; code?: string } | null } {
  if (solicitada === null) {
    return { conta: null, erro: null };
  }

  if (leitura?.error !== null) {
    return { conta: null, erro: leitura?.error ?? { message: "falha ao ler contas" } };
  }

  return {
    conta: leitura.data?.find((item) => comparar(item, solicitada)) ?? null,
    erro: null,
  };
}

/**
 * Resolve seleção múltipla de contas/lojas (`?contas=...`) contra
 * `marketplace_accounts`, falhando fechado quando o usuário pediu contas
 * específicas e a leitura falhou.
 */
export function resolverContasSolicitadas<
  T,
  R,
  E extends { message: string; code?: string } = { message: string; code?: string },
>(
  valor: string | string[] | undefined,
  leitura: { data: readonly T[] | null; error: E | null } | null,
  resolver: (raw: string, contas: readonly T[]) => R,
): { resultado: R | null; erro: E | { message: string; code?: string } | null } {
  if (typeof valor !== "string" || valor.trim() === "") {
    return { resultado: null, erro: null };
  }

  if (leitura?.error !== null) {
    return { resultado: null, erro: leitura?.error ?? { message: "falha ao ler contas" } };
  }

  return {
    resultado: resolver(valor, leitura.data ?? []),
    erro: null,
  };
}
