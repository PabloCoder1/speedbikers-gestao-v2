import { buildFilterHref } from "./filters";

/**
 * A mecânica da tela de templates de resposta (D-111, D-392).
 *
 * ## O orçamento da caixa de resposta é o eixo desta tela
 *
 * A caixa onde a resposta é escrita tem 2.000 caracteres (D-096), e é ela quem
 * manda: `lib/apply-template.ts` **recusa** inserir um template quando o texto
 * dele mais o rascunho já escrito passam desse teto — não corta no meio, porque
 * mandar uma frase pela metade para um cliente é pior que não inserir.
 *
 * A consequência nunca aparecia em lugar nenhum: quem escrevia o template não
 * tinha como saber que ele ocupava 1.800 dos 2.000 e que, na prática, só
 * entraria numa caixa vazia. O número não é enfeite — ele é o que separa um
 * template usável de um que vai falhar na hora do atendimento.
 */

/** O teto da caixa de resposta (D-096) — e, por isso, o do corpo do template. */
export const CAIXA_LIMITE = 2_000;

/** O teto do nome, espelhando `reply_templates.name` (`between 1 and 80`). */
export const NOME_LIMITE = 80;

/**
 * A partir daqui o template é APERTADO: ocupa 3/4 da caixa, e sobra menos de
 * uma tela de texto para a pessoa ajustar antes de enviar. Não é erro — é o
 * aviso de que ele provavelmente não vai caber junto de um rascunho.
 */
export const APERTADO_ACIMA_DE = Math.round(CAIXA_LIMITE * 0.75);

export const TEMPLATE_ORDENS = ["nome", "recentes", "maiores"] as const;

export type TemplateOrdem = (typeof TEMPLATE_ORDENS)[number];

export const TEMPLATE_ORDEM_LABEL: Record<TemplateOrdem, string> = {
  nome: "Nome (A–Z)",
  recentes: "Atualizados primeiro",
  maiores: "Maiores primeiro",
};

export interface TemplateFilters {
  /** Termo de busca, casado contra o NOME e o TEXTO — como na barra da resposta. */
  busca: string | null;
  ordem: TemplateOrdem;
}

function readParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function resolveBusca(value: string | null): string | null {
  const busca = value?.trim() ?? "";

  return busca === "" ? null : busca.slice(0, NOME_LIMITE);
}

export function resolveTemplateFilters(
  query: Record<string, string | string[] | undefined>,
): TemplateFilters {
  const ordem = readParam(query.ordem);

  return {
    busca: resolveBusca(readParam(query.busca)),
    // Ordem desconhecida na URL cai no padrão em vez de quebrar: link velho e
    // link torto levam à mesma tela útil.
    ordem: TEMPLATE_ORDENS.includes(ordem as TemplateOrdem) ? (ordem as TemplateOrdem) : "nome",
  };
}

export function buildTemplateHref(
  atual: TemplateFilters,
  override: Partial<TemplateFilters> = {},
): string {
  const proximo = { ...atual, ...override };

  return buildFilterHref(
    "/atendimento/templates",
    {
      busca: proximo.busca,
      // O padrão não vai para a URL: link limpo é link que se lê.
      ordem: proximo.ordem === "nome" ? null : proximo.ordem,
    },
    1,
  );
}

/** Quanto da caixa de resposta este texto ocupa, de 0 a 1 (pode passar de 1). */
export function ocupacaoDaCaixa(texto: string): number {
  return texto.length / CAIXA_LIMITE;
}

/** O template ocupa tanto da caixa que dificilmente cabe junto de um rascunho. */
export function estaApertado(texto: string): boolean {
  return texto.length > APERTADO_ACIMA_DE;
}

/**
 * O nome de uma CÓPIA, sem colidir com o que já existe.
 *
 * `unique (organization_id, name)` recusaria "Nome (cópia)" na segunda vez, e a
 * pessoa receberia "Já existe um template com esse nome" por um nome que ela
 * nem escolheu. O sufixo numera a partir da segunda cópia, e o corte em 80
 * respeita o CHECK da coluna — cortando o NOME, nunca o sufixo, senão o nome
 * cortado volta a colidir.
 */
export function nomeDaCopia(nome: string, existentes: readonly string[]): string {
  const tomados = new Set(existentes.map((outro) => outro.trim().toLowerCase()));

  for (let tentativa = 1; tentativa <= 50; tentativa += 1) {
    const sufixo = tentativa === 1 ? " (cópia)" : ` (cópia ${String(tentativa)})`;
    const base = nome.trim().slice(0, NOME_LIMITE - sufixo.length).trimEnd();
    const candidato = `${base}${sufixo}`;

    if (!tomados.has(candidato.toLowerCase())) {
      return candidato;
    }
  }

  // 50 cópias do mesmo template é uso que não existe; devolver o candidato
  // colidido faz o banco recusar com a mensagem certa, em vez de inventarmos
  // um nome aleatório que ninguém reconhece na lista.
  return `${nome.trim().slice(0, NOME_LIMITE - 12).trimEnd()} (cópia 51)`;
}
