import { AVATAR_BUCKET } from "./avatar";
import { createClient } from "./supabase/browser";

/**
 * Foto de perfil no navegador (D-354): preparar, enviar e trocar.
 *
 * **Quem autoriza é o banco**, não esta função: as policies do bucket e de
 * `profiles` só aceitam a própria pessoa ou um ADMIN da organização dela
 * (`private.can_edit_profile`). Chamar isto sem poder dá recusa, não foto.
 */

export const FOTO_TIPOS_ACEITOS = "image/jpeg,image/png,image/webp";

/** Lado do quadrado salvo: nítido no avatar de 88px em tela 2x e em ~60 KB. */
const LADO = 512;

/** Guarda contra travar a aba decodificando uma foto de 40 MB da câmera. */
const LIMITE_ORIGINAL = 15 * 1024 * 1024;

/**
 * Recorta no centro, reduz para 512×512 e reencoda.
 *
 * Reduzir AQUI, e não confiar no limite do bucket: a foto do celular tem 4 MB e
 * 4000px, e o avatar mostra 30px. Mandar o original seria pagar banda e
 * armazenamento por pixel que ninguém vê — e o limite de 1 MiB do bucket o
 * recusaria.
 *
 * WebP quando o navegador codifica; o Safari antigo devolve PNG em
 * `toBlob("image/webp")`, e o tipo real do blob é o que decide a extensão.
 */
export async function prepararFoto(arquivo: File): Promise<Blob> {
  if (!FOTO_TIPOS_ACEITOS.split(",").includes(arquivo.type)) {
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

  const lado = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");

  canvas.width = LADO;
  canvas.height = LADO;

  const contexto = canvas.getContext("2d");

  if (contexto === null) {
    bitmap.close();
    throw new Error("Este navegador não conseguiu processar a imagem.");
  }

  contexto.imageSmoothingQuality = "high";
  contexto.drawImage(bitmap, (bitmap.width - lado) / 2, (bitmap.height - lado) / 2, lado, lado, 0, 0, LADO, LADO);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.86);
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
 * Envia a foto e aponta o perfil para ela. Devolve o caminho novo.
 *
 * A ORDEM importa, e é a que não deixa o perfil apontando para o nada:
 * 1. sobe o arquivo novo (nome novo a cada envio — cache do navegador e da CDN
 *    nunca servem a foto antiga com o caminho novo);
 * 2. troca o caminho no perfil — se for recusado, o arquivo recém-enviado é
 *    apagado, e nada muda para ninguém;
 * 3. só então apaga a foto anterior. Se esse passo falhar, sobra um arquivo
 *    órfão, que é o defeito barato dos três.
 */
export async function salvarFoto(userId: string, foto: Blob, anterior: string | null): Promise<string> {
  const supabase = createClient();
  const caminho = `${userId}/${crypto.randomUUID()}.${extensao(foto.type)}`;

  const envio = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(caminho, foto, { contentType: foto.type, cacheControl: "31536000", upsert: false });

  if (envio.error !== null) {
    throw new Error(`A foto não subiu: ${envio.error.message}`);
  }

  const perfil = await supabase.from("profiles").update({ avatar_path: caminho }).eq("id", userId).select("id");

  /*
    Zero linhas SEM erro é a forma da recusa da RLS num UPDATE: a policy
    esconde a linha em vez de reclamar. Tratar só `error` diria "foto salva"
    sobre um perfil que não mudou.
  */
  if (perfil.error !== null || perfil.data.length === 0) {
    await supabase.storage.from(AVATAR_BUCKET).remove([caminho]);
    throw new Error("A foto subiu, mas o perfil não aceitou a troca. Só a própria pessoa ou um ADMIN pode mudá-la.");
  }

  if (anterior !== null && anterior !== caminho) {
    await supabase.storage.from(AVATAR_BUCKET).remove([anterior]);
  }

  return caminho;
}

/** Tira a foto: primeiro o perfil (volta às iniciais), depois o arquivo. */
export async function removerFoto(userId: string, atual: string): Promise<void> {
  const supabase = createClient();
  const perfil = await supabase.from("profiles").update({ avatar_path: null }).eq("id", userId).select("id");

  if (perfil.error !== null || perfil.data.length === 0) {
    throw new Error("O perfil não aceitou remover a foto. Só a própria pessoa ou um ADMIN pode mudá-la.");
  }

  await supabase.storage.from(AVATAR_BUCKET).remove([atual]);
}
