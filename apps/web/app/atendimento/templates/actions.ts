"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "../../../lib/supabase/server";

/**
 * Templates de resposta (Fase 7B, D-111) — Server Actions diretas sob RLS,
 * mesmo padrão de `/sugestoes` (D-079): as policies
 * `reply_templates_{insert,update,delete}_admin` refazem a autorização
 * (membro + ADMIN/GESTOR) no banco, então recusar aqui seria duplicar a
 * barreira; a UI só traduz o erro.
 *
 * O teto de 2000 espelha a caixa de resposta (D-096): template maior que o
 * campo onde será colado é template que nunca cabe.
 */

const NAME_LIMIT = 80;
const BODY_LIMIT = 2_000;

export interface TemplateActionResult {
  ok: boolean;
  message: string | null;
}

function validate(name: string, body: string): string | null {
  if (name.trim().length === 0) {
    return "Dê um nome ao template.";
  }

  if (name.trim().length > NAME_LIMIT) {
    return `O nome passa de ${String(NAME_LIMIT)} caracteres.`;
  }

  if (body.length === 0) {
    return "Escreva o texto do template.";
  }

  if (body.length > BODY_LIMIT) {
    return `O texto passa de ${String(BODY_LIMIT)} caracteres — o limite da caixa de resposta.`;
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
    supabase.from("organization_members").select("organization_id").maybeSingle(),
  ]);

  const userId = authResult.data.user?.id;
  const organizationId = membershipResult.data?.organization_id;

  if (userId === undefined || organizationId === undefined) {
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
