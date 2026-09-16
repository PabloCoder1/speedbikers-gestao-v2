/**
 * A REGRA de reposição como o formulário a vê (D-361): a validação campo a
 * campo e a régua que mostra o que os quatro números fazem.
 *
 * ## A validação espelha o banco, não o substitui
 *
 * Os limites são os `CHECK` de `replenishment_settings` (D-144/D-148): prazo e
 * cobertura de 1 a 365, segurança de 0 a 365, teto opcional de 1 a 1095 e
 * nunca abaixo da janela (`max_covers_window`), nota até 500. Recusar aqui dá a
 * frase certa NO CAMPO certo e antes da ida ao servidor; o banco continua sendo
 * a trava, e a Server Action roda esta mesma função.
 *
 * ## A régua é a de `classifyStockState`, desenhada
 *
 * Os limiares são os do estado operacional (D-148, `packages/domain`): até o
 * prazo, compra urgente; até prazo + segurança (o ponto de pedido), comprar em
 * breve; abaixo da janela (prazo + cobertura + segurança), cobertura baixa; na
 * janela, adequada; acima do teto, excesso. As faixas saem daqui para a tela
 * pintar com os MESMOS tons de `/reposicao` — quem configura vê as cores que vai
 * encontrar na reposição.
 */

export type CampoDaRegra = "lead_time_days" | "target_coverage_days" | "safety_stock_days" | "max_coverage_days" | "policy_note";

export interface ValoresDaRegra {
  readonly prazo: number;
  readonly cobertura: number;
  readonly seguranca: number;
  /** Nulo = excesso nunca afirmado (D-148). */
  readonly teto: number | null;
  readonly nota: string | null;
}

export type ResultadoDaValidacao =
  | { readonly ok: true; readonly valores: ValoresDaRegra }
  | { readonly ok: false; readonly erros: Partial<Record<CampoDaRegra, string>> };

export const LIMITES = {
  prazo: { min: 1, max: 365 },
  cobertura: { min: 1, max: 365 },
  seguranca: { min: 0, max: 365 },
  teto: { min: 1, max: 1095 },
  nota: { max: 500 },
} as const;

/** Inteiro de texto de formulário; `null` para vazio ou lixo ("12a", "1.5"). */
function inteiro(bruto: string): number | null {
  const texto = bruto.trim();

  if (!/^\d+$/.test(texto)) return null;

  return Number.parseInt(texto, 10);
}

export function janelaDaRegra(valores: { prazo: number; cobertura: number; seguranca: number }): number {
  return valores.prazo + valores.cobertura + valores.seguranca;
}

export function validarRegra(entrada: {
  prazo: string;
  cobertura: string;
  seguranca: string;
  teto: string;
  nota: string;
}): ResultadoDaValidacao {
  const erros: Partial<Record<CampoDaRegra, string>> = {};

  const prazo = inteiro(entrada.prazo);
  const cobertura = inteiro(entrada.cobertura);
  // Segurança vazia é zero: é o default da coluna, e "sem margem" é escolha legítima.
  const seguranca = entrada.seguranca.trim() === "" ? 0 : inteiro(entrada.seguranca);
  const teto = entrada.teto.trim() === "" ? null : inteiro(entrada.teto);

  if (prazo === null || prazo < LIMITES.prazo.min || prazo > LIMITES.prazo.max) {
    erros.lead_time_days = "Informe o prazo em dias inteiros, de 1 a 365.";
  }

  if (cobertura === null || cobertura < LIMITES.cobertura.min || cobertura > LIMITES.cobertura.max) {
    erros.target_coverage_days = "Informe a cobertura em dias inteiros, de 1 a 365.";
  }

  if (seguranca === null || seguranca < LIMITES.seguranca.min || seguranca > LIMITES.seguranca.max) {
    erros.safety_stock_days = "Informe a segurança em dias inteiros, de 0 a 365.";
  }

  if (entrada.teto.trim() !== "" && (teto === null || teto < LIMITES.teto.min || teto > LIMITES.teto.max)) {
    erros.max_coverage_days = "O teto é opcional; se informado, use dias inteiros de 1 a 1095.";
  }

  // O `max_covers_window` do banco: com teto abaixo da janela, toda cobertura
  // adequada já contaria como excesso — ADEQUADA ficaria impossível.
  if (
    erros.max_coverage_days === undefined &&
    teto !== null &&
    prazo !== null &&
    cobertura !== null &&
    seguranca !== null &&
    erros.lead_time_days === undefined &&
    erros.target_coverage_days === undefined &&
    erros.safety_stock_days === undefined
  ) {
    const janela = janelaDaRegra({ prazo, cobertura, seguranca });

    if (teto < janela) {
      erros.max_coverage_days = `O teto precisa ser de pelo menos ${String(janela)} dias — a janela (prazo + segurança + cobertura). Abaixo dela, estoque adequado contaria como excesso.`;
    }
  }

  const nota = entrada.nota.trim();

  if (nota.length > LIMITES.nota.max) {
    erros.policy_note = `A nota tem ${String(nota.length)} caracteres; o limite é ${String(LIMITES.nota.max)}.`;
  }

  if (Object.keys(erros).length > 0 || prazo === null || cobertura === null || seguranca === null) {
    return { ok: false, erros };
  }

  return { ok: true, valores: { prazo, cobertura, seguranca, teto, nota: nota === "" ? null : nota } };
}

export type FaixaDaRegua = "COMPRA_URGENTE" | "COMPRAR_EM_BREVE" | "COBERTURA_BAIXA" | "ADEQUADA" | "EXCESSO";

export interface ReguaDaPolitica {
  /** Até onde a régua vai, em dias — as faixas são porcentagens disto. */
  readonly escala: number;
  readonly faixas: readonly { readonly faixa: FaixaDaRegua; readonly de: number; readonly ate: number }[];
  readonly pontoDePedido: number;
  readonly janela: number;
  readonly teto: number | null;
}

/**
 * As faixas em dias de cobertura. Faixa de largura zero (segurança 0) sai da
 * lista em vez de virar um risco de 0 px na tela.
 *
 * Sem teto, a faixa adequada vai até o fim e não há excesso: a régua não
 * inventa o "demais" que o ADMIN não definiu. O fim é 25% além do último marco,
 * para a faixa final ter corpo visível.
 */
export function reguaDaPolitica(valores: {
  prazo: number;
  cobertura: number;
  seguranca: number;
  teto: number | null;
}): ReguaDaPolitica {
  const pontoDePedido = valores.prazo + valores.seguranca;
  const janela = janelaDaRegra(valores);
  const ultimoMarco = valores.teto ?? janela;
  const escala = Math.max(Math.ceil(ultimoMarco * 1.25), ultimoMarco + 1);

  const faixas: { faixa: FaixaDaRegua; de: number; ate: number }[] = [
    { faixa: "COMPRA_URGENTE", de: 0, ate: valores.prazo },
    { faixa: "COMPRAR_EM_BREVE", de: valores.prazo, ate: pontoDePedido },
    { faixa: "COBERTURA_BAIXA", de: pontoDePedido, ate: janela },
    { faixa: "ADEQUADA", de: janela, ate: valores.teto ?? escala },
  ];

  if (valores.teto !== null) {
    faixas.push({ faixa: "EXCESSO", de: valores.teto, ate: escala });
  }

  return {
    escala,
    faixas: faixas.filter((f) => f.ate > f.de),
    pontoDePedido,
    janela,
    teto: valores.teto,
  };
}

/**
 * A regra em uma frase de operação — o que o comprador precisa saber sem
 * decorar as quatro definições. Segue a régua da esquerda para a direita.
 */
export function fraseDaRegra(valores: { prazo: number; cobertura: number; seguranca: number; teto: number | null }): string {
  const regua = reguaDaPolitica(valores);
  const dias = (n: number): string => `${String(n)} ${n === 1 ? "dia" : "dias"}`;

  const pedido =
    valores.seguranca === 0
      ? `O pedido sai quando a cobertura chega a ${dias(regua.pontoDePedido)} — sem margem de segurança além do prazo.`
      : `O pedido sai quando a cobertura chega a ${dias(regua.pontoDePedido)} (prazo de ${dias(valores.prazo)} + ${dias(valores.seguranca)} de segurança).`;

  const excesso =
    valores.teto === null
      ? "Sem teto, excesso nunca é apontado."
      : `Acima de ${dias(valores.teto)}, é excesso.`;

  return `${pedido} Cada compra repõe até ${dias(regua.janela)} de venda. ${excesso}`;
}
