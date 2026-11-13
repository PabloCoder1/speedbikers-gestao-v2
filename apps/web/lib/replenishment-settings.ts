import { PAGINA_DO_POSTGREST } from "./rpc-pages";

interface PaginaDeRegras<T> {
  data: T[] | null;
  count: number | null;
  error: { message: string } | null;
}

export async function lerRegrasDeReposicao<T extends { id: string }>(
  lerPagina: (depoisDe: string | null, limite: number) => PromiseLike<PaginaDeRegras<T>>,
): Promise<{ data: T[]; error: null } | { data: null; error: { message: string } }> {
  const regras: T[] = [];
  let depoisDe: string | null = null;

  for (;;) {
    const pagina = await lerPagina(depoisDe, PAGINA_DO_POSTGREST);

    if (pagina.error !== null) return { data: null, error: pagina.error };

    const lote = pagina.data ?? [];
    regras.push(...lote);

    // A contagem exata já inclui o filtro de cursor. Uma página curta pode
    // ser o limite do servidor, então só a contagem ou um lote vazio confirma o fim.
    const ultimaRegra = lote.at(-1);
    if (ultimaRegra === undefined || lote.length === pagina.count) return { data: regras, error: null };

    depoisDe = ultimaRegra.id;
  }
}
