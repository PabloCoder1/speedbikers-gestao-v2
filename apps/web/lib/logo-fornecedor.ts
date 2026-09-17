import { LOGO_BUCKET } from "./logo-fornecedor-url";
import { createClient } from "./supabase/browser";

/**
 * Logo do fornecedor no navegador (D-370): preparar, enviar, trocar e tirar.
 *
 * O desenho é o da foto de perfil (`lib/foto-perfil.ts`, D-354), com duas
 * diferenças:
 *
 * - **logo não se recorta.** Uma logo é quase sempre mais larga que alta, e o
 *   recorte central do avatar cortaria o nome da marca. Ela é AJUSTADA dentro do
 *   quadrado, com o fundo transparente preservado (WebP/PNG);
 * - **o cadastro muda por RPC** (`set_supplier_logo`), e não por UPDATE direto:
 *   `suppliers` só muda por RPC, e é a RPC que confere o papel na organização e
 *   a pasta do caminho.
 *
 * Quem autoriza é o banco: as policies do bucket e a RPC só aceitam ADMIN ou
 * GESTOR da organização do fornecedor.
 */

export const LOGO_TIPOS_ACEITOS = "image/jpeg,image/png,image/webp";

const LADO = 512;
const LIMITE_ORIGINAL = 15 * 1024 * 1024;

export async function prepararLogo(arquivo: File): Promise<Blob> {
  if (!LOGO_TIPOS_ACEITOS.split(",").includes(arquivo.type)) {
    throw new Error("Use uma imagem JPG, PNG ou WebP.");
  }

  if (arquivo.size > LIMITE_ORIGINAL) {
    throw new Error("A imagem passa de 15 MB. Escolha uma menor.");
  }

  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(arquivo);
  } catch {
    throw new Error("Não foi possível ler esta imagem.");
  }

  // Ajusta dentro do quadrado, sem ampliar logo pequena (ampliar só borra).
  const escala = Math.min(1, LADO / Math.max(bitmap.width, bitmap.height));
  const largura = Math.max(1, Math.round(bitmap.width * escala));
  const altura = Math.max(1, Math.round(bitmap.height * escala));
  const canvas = document.createElement("canvas");

  canvas.width = LADO;
  canvas.height = LADO;

  const contexto = canvas.getContext("2d");

  if (contexto === null) {
    bitmap.close();
    throw new Error("Este navegador não conseguiu processar a imagem.");
  }

  contexto.imageSmoothingQuality = "high";
  contexto.drawImage(bitmap, (LADO - largura) / 2, (LADO - altura) / 2, largura, altura);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.9);
  });

  if (blob === null) {
    throw new Error("Não foi possível converter a imagem.");
  }

  return blob;
}

function extensao(tipo: string): string {
  if (tipo === "image/webp") return "webp";
  if (tipo === "image/jpeg") return "jpg";

  return "png";
}

/**
 * Envia a logo e aponta o fornecedor para ela. A ordem é a de `salvarFoto`:
 * sobe o arquivo novo (nome novo a cada envio, sem cache velho), troca o
 * caminho no cadastro — se recusado, apaga o que acabou de subir — e só então
 * apaga a logo anterior, que a RPC devolve.
 */
export async function enviarLogo(organizationId: string, supplierId: string, logo: Blob): Promise<string> {
  const supabase = createClient();
  const caminho = `${organizationId}/${crypto.randomUUID()}.${extensao(logo.type)}`;

  const envio = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(caminho, logo, { contentType: logo.type, cacheControl: "31536000", upsert: false });

  if (envio.error !== null) {
    throw new Error(`A logo não subiu: ${envio.error.message}`);
  }

  const troca = await supabase.rpc("set_supplier_logo", { p_id: supplierId, p_logo_path: caminho });

  if (troca.error !== null) {
    await supabase.storage.from(LOGO_BUCKET).remove([caminho]);
    throw new Error("A logo subiu, mas o cadastro não aceitou a troca. Só ADMIN e GESTOR podem mudá-la.");
  }

  const anterior = troca.data;

  if (anterior !== null && anterior !== caminho) {
    await supabase.storage.from(LOGO_BUCKET).remove([anterior]);
  }

  return caminho;
}

/** Tira a logo: primeiro o cadastro (volta às iniciais), depois o arquivo. */
export async function removerLogo(supplierId: string): Promise<void> {
  const supabase = createClient();
  const troca = await supabase.rpc("set_supplier_logo", { p_id: supplierId });

  if (troca.error !== null) {
    throw new Error("O cadastro não aceitou remover a logo. Só ADMIN e GESTOR podem mudá-la.");
  }

  const anterior = troca.data;

  if (anterior !== null) {
    await supabase.storage.from(LOGO_BUCKET).remove([anterior]);
  }
}
