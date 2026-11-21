/**
 * Saída Manual (D-766) — regras da tela que não dependem do React.
 *
 * Os limites espelham os da `api` (`apps/api/src/manual-exit.ts`): a tela
 * avisa antes, a `api` decide.
 */

export const TIPOS_DE_SAIDA = [
  { valor: "OUTROS", rotulo: "Outros" },
  { valor: "PERDAS", rotulo: "Perdas" },
  { valor: "TRANSFERENCIAS", rotulo: "Transferências" },
] as const;

export type TipoDeSaida = (typeof TIPOS_DE_SAIDA)[number]["valor"];

export const OBSERVACAO_MAX = 450;
export const MAX_ITENS = 300;
export const MAX_QUANTIDADE = 1_000_000;
/** Lote seguro de chaves/UUIDs no `.in()` do PostgREST para evitar HTTP 414 (D-771). */
export const LOTE_CONSULTA_SAIDA = 100;
/** Teto de códigos distintos consultados ao colar uma lista antes de contar o excedente. */
export const MAX_CHAVES_IMPORTACAO = 1_000;

/** Divide uma lista em lotes de tamanho fixo para consultas `.in()` sem estourar URL (D-771). */
export function particionarEmLotes<T>(itens: readonly T[], tamanho = LOTE_CONSULTA_SAIDA): T[][] {
  const lotes: T[][] = [];

  for (let inicio = 0; inicio < itens.length; inicio += tamanho) {
    lotes.push(itens.slice(inicio, inicio + tamanho));
  }

  return lotes;
}

/** Soma quantidades na lista respeitando `MAX_QUANTIDADE`, sem gerar valor inválido (D-771). */
export function somarQuantidadeNoLimite(atual: number, extra: number): number {
  return Math.min(MAX_QUANTIDADE, atual + extra);
}

/** Confirma que a resposta 200 da saída manual carrega o mesmo `requestId` enviado (D-771). */
export function respostaDeSaidaValida(payload: unknown, requestId: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    (payload as { requestId?: unknown }).requestId === requestId
  );
}

/** Confirma que a resposta 200 de edição de item devolve a contagem atualizada (D-771). */
export function respostaDeEdicaoDeItemValida(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "totalItems" in payload &&
    typeof (payload as { totalItems?: unknown }).totalItems === "number"
  );
}

/** A mesma normalização da coluna gerada `skus.sku_key`: `upper(btrim(sku))`. */
export function chaveDoSku(codigo: string): string {
  return codigo.trim().toUpperCase();
}

/** Quantidade de uma linha: inteiro de 1 ao limite, ou `null` se não for. */
export function quantidadeValida(texto: string): number | null {
  const limpo = texto.trim();

  if (!/^\d+$/.test(limpo)) return null;

  const valor = Number(limpo);

  return valor >= 1 && valor <= MAX_QUANTIDADE ? valor : null;
}

export interface LinhaImportada {
  codigo: string;
  quantidade: number;
}

/**
 * Lê a lista colada ou o arquivo de texto do "Importar SKU": uma linha por SKU,
 * o código e a quantidade separados por tabulação, ponto e vírgula, vírgula ou
 * espaço — o que sai de uma planilha copiada ou de um CSV. Sem quantidade, é 1.
 *
 * O mesmo SKU em duas linhas soma (a `api` exige uma linha por SKU). Linha que
 * não se lê volta pelo número, para a tela dizer qual foi.
 */
export function lerListaDeSkus(texto: string): { linhas: LinhaImportada[]; invalidas: number[] } {
  const porChave = new Map<string, LinhaImportada>();
  const invalidas: number[] = [];

  texto.split(/\r?\n/).forEach((bruta, indice) => {
    const linha = bruta.trim();

    if (linha === "") return;

    const partes = linha.split(/[\t;,]|\s+/).filter((parte) => parte !== "");
    const [codigo, quantidadeTexto, ...resto] = partes;

    // Cabeçalho de planilha ("SKU;Quantidade") não é erro: só é pulado.
    if (indice === 0 && quantidadeTexto !== undefined && quantidadeValida(quantidadeTexto) === null && /^sku$/i.test(codigo ?? "")) {
      return;
    }

    const quantidade = quantidadeTexto === undefined ? 1 : quantidadeValida(quantidadeTexto);

    if (codigo === undefined || quantidade === null || resto.length > 0) {
      invalidas.push(indice + 1);

      return;
    }

    const chave = chaveDoSku(codigo);
    const anterior = porChave.get(chave);

    porChave.set(chave, {
      codigo: anterior?.codigo ?? codigo,
      quantidade: Math.min(MAX_QUANTIDADE, (anterior?.quantidade ?? 0) + quantidade),
    });
  });

  return { linhas: [...porChave.values()], invalidas };
}

/** A mensagem de erro que a `api` devolve em `{ error: { message } }`, se houver. */
export function mensagemDaApi(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return undefined;

  const erro = (payload as { error?: unknown }).error;

  if (typeof erro !== "object" || erro === null || !("message" in erro)) return undefined;

  const mensagem = (erro as { message?: unknown }).message;

  return typeof mensagem === "string" && mensagem !== "" ? mensagem : undefined;
}
