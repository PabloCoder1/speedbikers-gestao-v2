/**
 * A URL pública da logo do fornecedor (D-370) — o par de `lib/avatar.ts`.
 *
 * O banco guarda o CAMINHO (`suppliers.logo_path`, `<organization_id>/<arquivo>`)
 * e a URL é montada aqui, na hora: ela depende do projeto Supabase (Dev x
 * produção). O bucket é público, então servidor e navegador montam a mesma URL
 * sem ida nenhuma ao banco.
 */

export const LOGO_BUCKET = "supplier-logos";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");

export function urlDaLogo(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path === "" || SUPABASE_URL === "") return null;

  return `${SUPABASE_URL}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
}
