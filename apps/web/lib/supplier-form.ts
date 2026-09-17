/**
 * O cadastro de fornecedor conferido ANTES de ir ao banco (D-366) — puro e
 * testável.
 *
 * O banco só exige o nome (1 a 200 caracteres) e a unicidade dele na
 * organização. O resto é texto livre, e era assim que um CNPJ com um dígito a
 * menos ou um e-mail sem arroba entravam calados e só apareciam errados na hora
 * de usar. A conferência aqui recusa o que é inequivocamente errado e diz
 * ONDE — campo a campo, para o formulário marcar o campo.
 *
 * O documento é guardado só com dígitos: busca, gaveta e lista formatam na
 * exibição (`formatarDocumento`), e duas grafias do mesmo CNPJ deixam de ser
 * dois textos diferentes.
 */

export const CAMPOS_FORNECEDOR = [
  "name",
  "legalName",
  "document",
  "contactName",
  "email",
  "phone",
  "whatsapp",
  "website",
  "notes",
] as const;

export type CampoFornecedor = (typeof CAMPOS_FORNECEDOR)[number];

export interface CadastroFornecedor {
  name: string;
  legalName: string | null;
  document: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  notes: string | null;
}

export type ResultadoCadastro =
  { ok: true; cadastro: CadastroFornecedor } | { ok: false; erros: Partial<Record<CampoFornecedor, string>> };

const soDigitos = (v: string): string => v.replace(/\D/g, "");

function digitoVerificador(base: string, pesos: readonly number[]): number {
  const soma = pesos.reduce((acc, peso, i) => acc + Number(base[i]) * peso, 0);
  const resto = soma % 11;

  return resto < 2 ? 0 : 11 - resto;
}

export function cnpjValido(valor: string): boolean {
  const d = soDigitos(valor);

  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;

  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, ...p1];

  return digitoVerificador(d, p1) === Number(d[12]) && digitoVerificador(d, p2) === Number(d[13]);
}

export function cpfValido(valor: string): boolean {
  const d = soDigitos(valor);

  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;

  const p1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [11, ...p1];

  return digitoVerificador(d, p1) === Number(d[9]) && digitoVerificador(d, p2) === Number(d[10]);
}

/** Texto aparado; vazio vira ausência — o banco guarda NULL, nunca "". */
export function texto(valor: unknown): string | null {
  if (typeof valor !== "string") return null;

  const aparado = valor.trim();

  return aparado === "" ? null : aparado;
}

/**
 * `documentoAnterior` é o que já está gravado, na edição. Cadastro antigo com
 * documento fora da regra continua editável: só o documento NOVO ou ALTERADO é
 * conferido — senão corrigir o telefone exigiria antes consertar um CNPJ que
 * ninguém tocou.
 */
export function conferirCadastro(
  entrada: Partial<Record<CampoFornecedor, unknown>>,
  opcoes: { documentoAnterior?: string | null } = {},
): ResultadoCadastro {
  const erros: Partial<Record<CampoFornecedor, string>> = {};

  const name = texto(entrada.name);
  const document = texto(entrada.document);
  const email = texto(entrada.email);
  const phone = texto(entrada.phone);
  const whatsapp = texto(entrada.whatsapp);

  if (name === null) erros.name = "Informe o nome do fornecedor.";
  else if (name.length > 200) erros.name = "O nome pode ter até 200 caracteres.";

  let documentoGuardado: string | null = null;

  if (document !== null) {
    const d = soDigitos(document);
    const anterior = opcoes.documentoAnterior ?? null;

    if (anterior !== null && (anterior.trim() === document || soDigitos(anterior) === d)) {
      // Intocado: guarda como estava, sem conferir.
      documentoGuardado = anterior;
    } else if (d.length === 14) {
      if (cnpjValido(d)) documentoGuardado = d;
      else erros.document = "CNPJ inválido — confira os dígitos.";
    } else if (d.length === 11) {
      if (cpfValido(d)) documentoGuardado = d;
      else erros.document = "CPF inválido — confira os dígitos.";
    } else {
      erros.document = "Use um CNPJ (14 dígitos) ou CPF (11 dígitos).";
    }
  }

  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    erros.email = "E-mail inválido.";
  }

  // Telefone com DDD: 10 ou 11 dígitos, ou 12/13 com o 55 na frente.
  const telefoneOk = (v: string): boolean => {
    const d = soDigitos(v);

    return d.length === 10 || d.length === 11 || ((d.length === 12 || d.length === 13) && d.startsWith("55"));
  };

  if (phone !== null && !telefoneOk(phone)) erros.phone = "Informe o telefone com DDD.";
  if (whatsapp !== null && !telefoneOk(whatsapp)) erros.whatsapp = "Informe o WhatsApp com DDD.";

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    cadastro: {
      name: name ?? "",
      legalName: texto(entrada.legalName),
      document: documentoGuardado,
      contactName: texto(entrada.contactName),
      email: email === null ? null : email.toLowerCase(),
      phone,
      whatsapp,
      website: texto(entrada.website),
      notes: texto(entrada.notes),
    },
  };
}
