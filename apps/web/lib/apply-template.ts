/**
 * Insere um template na caixa de resposta (D-111).
 *
 * Campo vazio: o template vira o texto. Campo com rascunho: o template é
 * ACRESCENTADO depois de uma linha em branco — apagar silenciosamente o que
 * a pessoa já escreveu seria pior que qualquer conveniência.
 *
 * O resultado respeita o teto do campo (o mesmo 2000 do envio, D-096):
 * quando a soma estoura, o template NÃO é inserido e o chamador avisa —
 * truncar no meio mandaria uma frase cortada para um cliente.
 */
export interface ApplyTemplateResult {
  text: string;
  applied: boolean;
}

export function applyTemplate(current: string, templateBody: string, limit: number): ApplyTemplateResult {
  const base = current.trimEnd();
  const next = base.length === 0 ? templateBody : `${base}\n\n${templateBody}`;

  if (next.length > limit) {
    return { text: current, applied: false };
  }

  return { text: next, applied: true };
}
