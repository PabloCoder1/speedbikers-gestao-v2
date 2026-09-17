/**
 * O guia do formulário de fornecedor (D-367) — o que a tela diz ENQUANTO a
 * pessoa digita, puro e testável.
 *
 * `supplier-form.ts` confere na hora de salvar e recusa o que é inequivocamente
 * errado. Aqui ficam os avisos que chegam antes: o documento que já não fecha
 * os dígitos, o fornecedor que já existe com outro jeito de escrever o nome, e
 * quanto do cadastro está preenchido. Nada daqui bloqueia: quem decide
 * continua sendo `conferirCadastro` e o banco.
 */

import { cnpjValido, cpfValido } from "./supplier-form";

const soDigitos = (valor: string): string => valor.replace(/\D/g, "");

export interface ValoresGuia {
  name: string;
  legalName: string;
  document: string;
  contactName: string;
  email: string;
  phone: string;
  whatsapp: string;
  website: string;
  notes: string;
}

export type EstadoDocumento =
  | { tipo: "vazio" }
  | { tipo: "digitando"; faltam: number }
  | { tipo: "valido"; rotulo: "CNPJ" | "CPF" }
  | { tipo: "invalido"; texto: string };

/**
 * O selo ao lado do CNPJ/CPF. Até 11 dígitos pode ser um CPF completo ou um
 * CNPJ pela metade: com 11 válidos é CPF; com 11 inválidos ainda pode virar
 * CNPJ, então o selo diz quanto falta em vez de acusar erro.
 */
export function estadoDocumento(valor: string): EstadoDocumento {
  const d = soDigitos(valor);

  if (d.length === 0) return { tipo: "vazio" };
  if (d.length === 14) return cnpjValido(d) ? { tipo: "valido", rotulo: "CNPJ" } : { tipo: "invalido", texto: "CNPJ não confere" };
  if (d.length > 14) return { tipo: "invalido", texto: "dígitos a mais" };
  if (d.length === 11 && cpfValido(d)) return { tipo: "valido", rotulo: "CPF" };
  if (d.length < 11) return { tipo: "digitando", faltam: 11 - d.length };

  return { tipo: "digitando", faltam: 14 - d.length };
}

/** "(11) 98765-4321" / "(11) 3333-4444". O que não tem 10 ou 11 dígitos fica como veio. */
export function formatarTelefone(valor: string): string {
  const bruto = valor.trim();
  let d = soDigitos(bruto);

  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;

  return bruto;
}

/** Nome comparável: sem acento, sem caixa, sem pontuação e sem sufixo societário. */
export function nomeComparavel(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ltda|me|epp|eireli|s a|sa|cia)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FornecedorExistente {
  readonly id: string;
  readonly name: string;
  readonly document: string | null;
  readonly isActive: boolean;
}

export interface Duplicados {
  /** Mesmo nome comparável — o banco recusaria o nome idêntico; o parecido ele aceitaria calado. */
  readonly porNome: FornecedorExistente | null;
  /** Mesmo CNPJ/CPF — o banco não impede, e dois cadastros dividiriam o histórico de compra. */
  readonly porDocumento: FornecedorExistente | null;
}

/** `idAtual`: na edição, o próprio fornecedor não é duplicado de si mesmo. */
export function acharDuplicados(
  existentes: readonly FornecedorExistente[],
  valores: Pick<ValoresGuia, "name" | "document">,
  idAtual: string | null,
): Duplicados {
  const outros = existentes.filter((f) => f.id !== idAtual);
  const nome = nomeComparavel(valores.name);
  const documento = soDigitos(valores.document);

  return {
    porNome: nome.length < 3 ? null : (outros.find((f) => nomeComparavel(f.name) === nome) ?? null),
    porDocumento:
      documento.length !== 11 && documento.length !== 14
        ? null
        : (outros.find((f) => f.document !== null && soDigitos(f.document) === documento) ?? null),
  };
}

export interface ItemCompletude {
  readonly chave: string;
  readonly rotulo: string;
  readonly feito: boolean;
}

/**
 * O que faz um cadastro de fornecedor servir na hora de comprar. Telefone e
 * WhatsApp contam como UM item ("um jeito de ligar"): exigir os dois puniria
 * quem só atende por um.
 */
export function completude(valores: ValoresGuia): { itens: readonly ItemCompletude[]; feitos: number; percentual: number } {
  const preenchido = (v: string): boolean => v.trim() !== "";
  const documento = estadoDocumento(valores.document);

  const itens: ItemCompletude[] = [
    { chave: "name", rotulo: "Nome", feito: preenchido(valores.name) },
    { chave: "document", rotulo: "CNPJ ou CPF válido", feito: documento.tipo === "valido" },
    { chave: "legalName", rotulo: "Razão social", feito: preenchido(valores.legalName) },
    { chave: "contactName", rotulo: "Pessoa de contato", feito: preenchido(valores.contactName) },
    { chave: "fone", rotulo: "WhatsApp ou telefone", feito: preenchido(valores.whatsapp) || preenchido(valores.phone) },
    { chave: "email", rotulo: "E-mail", feito: preenchido(valores.email) },
    { chave: "notes", rotulo: "Condições comerciais", feito: preenchido(valores.notes) },
  ];

  const feitos = itens.filter((i) => i.feito).length;

  return { itens, feitos, percentual: Math.round((feitos / itens.length) * 100) };
}

/** Os atalhos das observações: cada um vira uma linha "Rótulo: " no fim do texto. */
export const CONDICOES = ["Pedido mínimo", "Prazo de entrega", "Pagamento", "Frete", "Representante"] as const;

/** Acrescenta a linha sem duplicar a que já existe, e sem linha em branco sobrando. */
export function acrescentarCondicao(notas: string, condicao: string): string {
  const linhas = notas.split("\n");

  if (linhas.some((l) => l.trimStart().toLowerCase().startsWith(`${condicao.toLowerCase()}:`))) return notas;

  const base = notas.replace(/\s+$/, "");

  return `${base === "" ? "" : `${base}\n`}${condicao}: `;
}
