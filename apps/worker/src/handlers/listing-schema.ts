import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * Formato de um item do Mercado Livre, `GET /items/{item_id}` — campos
 * confirmados por leitura direta (`developers.mercadolivre.com.br`,
 * "Items & Searches", 2026-08-23; `status` confirmado como filtro válido na
 * mesma página — `?status=active`). Só os campos que `listings` usa hoje
 * (`docs/DATABASE.md`); estender é aditivo.
 *
 * Foto e link (2026-09-18, `/anuncios`) entram OPCIONAIS: um item sem eles
 * continua sendo gravado, e a tela mostra o monograma.
 */
export const listingItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  price: z.number(),
  currency_id: z.string(),
  available_quantity: z.number(),
  category_id: z.string().nullable().optional(),
  secure_thumbnail: z.string().nullable().optional(),
  thumbnail: z.string().nullable().optional(),
  permalink: z.string().nullable().optional(),
  pictures: z.array(z.object({ id: z.string() })).nullable().optional(),
  // Gatilho para reler a descrição no endpoint separado. Pode faltar no
  // payload real, por isso não bloqueia a sincronização do catálogo.
  last_updated: z.string().nullable().optional(),
});

export type ParsedListingItem = z.infer<typeof listingItemSchema>;

/**
 * O endereço só passa se for `https` e do domínio esperado.
 *
 * Os dois vão parar num `src` e num `href` da tela. O valor vem do Mercado
 * Livre, mas a regra não depende de confiar nele: um `javascript:` ou um host
 * qualquer vira NULO aqui, antes de chegar ao banco — e a CSP da web só abre
 * `img-src` para o `mlstatic.com`, então uma foto de outro host nem carregaria.
 */
function enderecoConfiavel(bruto: string | null | undefined, dominio: string): string | null {
  if (bruto === null || bruto === undefined || bruto === "") return null;

  // A API ainda devolve `thumbnail` em `http://`; o mesmo arquivo existe em https.
  const texto = bruto.startsWith("http://") ? `https://${bruto.slice("http://".length)}` : bruto;

  let url: URL;

  try {
    url = new URL(texto);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (url.protocol !== "https:" || (host !== dominio && !host.endsWith(`.${dominio}`))) return null;

  return url.toString();
}

/** A miniatura do item: `secure_thumbnail` primeiro, `thumbnail` como reserva. */
export function fotoDoItem(item: Pick<ParsedListingItem, "secure_thumbnail" | "thumbnail">): string | null {
  return enderecoConfiavel(item.secure_thumbnail, "mlstatic.com") ?? enderecoConfiavel(item.thumbnail, "mlstatic.com");
}

/** O endereço público do anúncio. */
export function linkDoItem(item: Pick<ParsedListingItem, "permalink">): string | null {
  return enderecoConfiavel(item.permalink, "mercadolivre.com.br");
}

/**
 * A ordem e as URLs das imagens podem mudar sem uma edição editorial. A lista
 * de IDs é o identificador estável devolvido pelo ML para detectar troca real
 * de foto, sem gravar URL nem conteúdo da imagem no evento.
 */
export function fingerprintDasFotos(item: Pick<ParsedListingItem, "pictures">): string | null {
  if (item.pictures === null || item.pictures === undefined || item.pictures.length === 0) return null;

  return item.pictures.map((picture) => picture.id).sort().join(":");
}

/**
 * A descrição (D-390) vem de `GET /items/{item_id}/description`, um recurso
 * à parte do item — nunca do multiget. Diferente da foto (que tem IDs
 * estáveis para comparar), a descrição só tem o texto em si, e o texto NUNCA
 * é gravado: nem no evento, nem em `listings` — o hash é só para detectar
 * "mudou", igual ao fingerprint de foto faz com o conteúdo da imagem.
 *
 * `null` para descrição ausente (item sem descrição própria) — hash de string
 * vazia seria um valor válido e colidiria com "não lido ainda".
 */
export function fingerprintDaDescricao(plainText: string | null): string | null {
  if (plainText === null) return null;

  return createHash("sha256").update(plainText, "utf8").digest("hex");
}
