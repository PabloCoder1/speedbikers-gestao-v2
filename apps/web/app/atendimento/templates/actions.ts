"use server";

import { revalidatePath } from "next/cache";

import { CAIXA_LIMITE, NOME_LIMITE, nomeDaCopia } from "../../../lib/template-filters";
import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";

/**
 * Templates de resposta (Fase 7B, D-111) — Server Actions diretas sob RLS,
 * mesmo padrão de `/sugestoes` (D-079): as policies
 * `reply_templates_{insert,update,delete}_admin` refazem a autorização
 * (membro + ADMIN/GESTOR) no banco, então recusar aqui seria duplicar a
 * barreira; a UI só traduz o erro.
 *
 * O teto de 2000 espelha a caixa de resposta (D-096): template maior que o
 * campo onde será colado é template que nunca cabe. Os dois limites moram em
 * `lib/template-filters.ts` desde D-392, porque a TELA também precisa deles
 * para medir o orçamento da caixa — dois números iguais em arquivos diferentes
 * é um deles envelhecer sozinho.
 */

export interface TemplateActionResult {
  ok: boolean;
  message: string | null;
}

function validate(name: string, body: string): string | null {
  if (name.trim().length === 0) {
    return "Dê um nome ao template.";
  }

  if (name.trim().length > NOME_LIMITE) {
    return `O nome passa de ${String(NOME_LIMITE)} caracteres.`;
  }

  if (body.length === 0) {
    return "Escreva o texto do template.";
  }

  if (body.length > CAIXA_LIMITE) {
    return `O texto passa de ${String(CAIXA_LIMITE)} caracteres — o limite da caixa de resposta.`;
  }

  return null;
}

/** `23505` = nome repetido na organização (`unique (organization_id, name)`). */
function translate(code: string | undefined, message: string): string {
  if (code === "23505") {
    return "Já existe um template com esse nome.";
  }

  if (/permission denied|row-level security/i.test(message)) {
    return "Só ADMIN e GESTOR podem gerenciar templates.";
  }

  return message;
}

export async function createTemplate(name: string, body: string): Promise<TemplateActionResult> {
  const invalid = validate(name, body);

  if (invalid !== null) {
    return { ok: false, message: invalid };
  }

  const supabase = await createClient();

  const [authResult, membershipResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
  ]);

  const userId = authResult.data.user?.id;
  const organizationId = membershipResult.organizationId;

  if (userId === undefined || organizationId === null) {
    return { ok: false, message: "Sessão expirada — atualize a página." };
  }

  const result = await supabase.from("reply_templates").insert({
    organization_id: organizationId,
    created_by: userId,
    name: name.trim(),
    body,
  });

  if (result.error !== null) {
    return { ok: false, message: translate(result.error.code, result.error.message) };
  }

  revalidatePath("/atendimento/templates");

  return { ok: true, message: null };
}

export async function updateTemplate(
  id: string,
  name: string,
  body: string,
): Promise<TemplateActionResult> {
  const invalid = validate(name, body);

  if (invalid !== null) {
    return { ok: false, message: invalid };
  }

  const supabase = await createClient();

  const result = await supabase
    .from("reply_templates")
    .update({ name: name.trim(), body })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (result.error !== null) {
    return { ok: false, message: translate(result.error.code, result.error.message) };
  }

  // RLS filtra silenciosamente o que o papel não alcança: zero linha aqui é
  // "sem permissão", não "sucesso vazio".
  if (result.data === null) {
    return { ok: false, message: "Só ADMIN e GESTOR podem gerenciar templates." };
  }

  revalidatePath("/atendimento/templates");

  return { ok: true, message: null };
}

/**
 * DUPLICAR (D-392) — escrever uma variante é o jeito mais comum de criar um
 * template novo ("Troca de produto" vira "Troca de produto — fora do prazo"),
 * e antes disto a pessoa copiava o texto na mão de um campo para o outro.
 *
 * O texto é copiado DO BANCO, não do que a tela tinha na tela: duplicar uma
 * versão desatualizada, sem ninguém perceber, seria pior que recusar. E o nome
 * sai de `nomeDaCopia`, que consulta os nomes já usados — `unique (org, name)`
 * recusaria a segunda cópia com um erro por um nome que ninguém escolheu.
 */
export async function duplicateTemplate(id: string): Promise<TemplateActionResult> {
  const supabase = await createClient();

  const [authResult, membershipResult, originResult, nomesResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
    supabase.from("reply_templates").select("name, body").eq("id", id).maybeSingle(),
    supabase.from("reply_templates").select("name"),
  ]);

  const userId = authResult.data.user?.id;
  const organizationId = membershipResult.organizationId;

  if (userId === undefined || organizationId === null) {
    return { ok: false, message: "Sessão expirada — atualize a página." };
  }

  if (originResult.error !== null) {
    return { ok: false, message: translate(originResult.error.code, originResult.error.message) };
  }

  if (originResult.data === null) {
    return { ok: false, message: "Este template não existe mais — atualize a página." };
  }

  if (nomesResult.error !== null) {
    return { ok: false, message: translate(nomesResult.error.code, nomesResult.error.message) };
  }

  const result = await supabase.from("reply_templates").insert({
    organization_id: organizationId,
    created_by: userId,
    name: nomeDaCopia(originResult.data.name, nomesResult.data.map((linha) => linha.name)),
    body: originResult.data.body,
  });

  if (result.error !== null) {
    return { ok: false, message: translate(result.error.code, result.error.message) };
  }

  revalidatePath("/atendimento/templates");

  return { ok: true, message: null };
}

export async function deleteTemplate(id: string): Promise<TemplateActionResult> {
  const supabase = await createClient();

  const result = await supabase.from("reply_templates").delete().eq("id", id).select("id").maybeSingle();

  if (result.error !== null) {
    return { ok: false, message: translate(result.error.code, result.error.message) };
  }

  if (result.data === null) {
    return { ok: false, message: "Só ADMIN e GESTOR podem gerenciar templates." };
  }

  revalidatePath("/atendimento/templates");

  return { ok: true, message: null };
}
