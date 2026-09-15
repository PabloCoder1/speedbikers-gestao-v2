/**
 * A URL pública da foto de perfil (D-354).
 *
 * O banco guarda o CAMINHO (`profiles.avatar_path`, `<user_id>/<arquivo>`), e a
 * URL é montada aqui, na hora: ela depende do projeto Supabase (Dev x
 * produção), e gravada ela envelheceria no primeiro restore entre ambientes.
 *
 * Sem ida nenhuma ao servidor: o bucket é público de propósito (a foto está no
 * topo de toda página, e URL assinada seria uma consulta a mais no Shell —
 * D-195). `NEXT_PUBLIC_*` é embutido no build, então a mesma função serve ao
 * servidor e ao navegador.
 */

export const AVATAR_BUCKET = "avatars";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");

export function urlDoAvatar(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path === "" || SUPABASE_URL === "") return null;

  return `${SUPABASE_URL}/storage/v1/object/public/${AVATAR_BUCKET}/${path}`;
}
