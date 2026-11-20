/** Menor que CHUNK de escrita: chaves viram filtro `.in()` na URL, não corpo. */
export const LOOKUP_CHUNK = 200;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }

  return out;
}
