/**
 * A leitura de `get_documents_overview` (D-375) — contrato conferido campo a
 * campo, sem React e sem banco.
 *
 * Mesmo desenho de `lib/products-overview.ts` e `lib/purchase-orders-overview.ts`:
 * a RPC devolve `jsonb`, e uma resposta fora do contrato é recusada INTEIRA. Um
 * campo renomeado no SQL não pode chegar como `undefined` e sair "—", que se lê
 * como "não observado".
 *
 * Nada aqui soma: contagens, unidades e valores vêm do SQL.
 */

/** Os quatro layouts, mais o estado "ainda não lido". */
export const TIPOS_DOCUMENTO = ["NFE", "DANFE_PDF", "SAIDA_UPSELLER_PDF", "ENVIO_FULL_ML_PDF"] as const;

export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number];

export interface LinhaDocumento {
  readonly id: string;
  readonly file_name: string;
  readonly status: string;
  readonly operation_type: string | null;
  /** `null` enquanto a leitura não terminou: o tipo sai do conteúdo, não do nome. */
  readonly document_type: string | null;
  /** `XML` ou `PDF` — sabido no upload. */
  readonly source_format: string | null;
  readonly document_number: string | null;
  readonly series: string | null;
  readonly access_key: string | null;
  readonly issuer_name: string | null;
  readonly issuer_cnpj: string | null;
  /** A linha que explica o documento a quem confere (armazém, nº do envio). */
  readonly reference: string | null;
  readonly issue_date: string | null;
  readonly total_items: number | null;
  readonly resolved_items: number | null;
  readonly unidades: number;
  /** Soma de quantidade × valor unitário. Zero quando o documento não traz valor. */
  readonly valor: number;
  readonly created_at: string;
  readonly applied_at: string | null;
  readonly last_error: string | null;
}

export interface ContagensDocumentos {
  /** Chave = `documents.status`. */
  readonly estado: Readonly<Record<string, number>>;
  /** Chave = `ENTRADA`, `SAIDA` ou `SEM_DIRECAO` (ainda não lido). */
  readonly direcao: Readonly<Record<string, number>>;
  /** Chave = um dos quatro tipos ou `EM_LEITURA`. */
  readonly tipo: Readonly<Record<string, number>>;
}

export interface ResumoDocumentos {
  readonly total: number;
  readonly em_conferencia: number;
  readonly em_leitura: number;
  readonly falhas: number;
  readonly aplicados_30d: number;
  readonly entradas_30d: number;
  readonly saidas_30d: number;
  readonly itens_sem_vinculo: number;
}

export interface VisaoDocumentos {
  readonly total: number;
  readonly linhas: readonly LinhaDocumento[];
  readonly contagens: ContagensDocumentos;
  readonly resumo: ResumoDocumentos;
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Um mapa `{ chave: número }` — as chaves são dados (estados, tipos), não um contrato fixo. */
function lerMapa(v: unknown): Record<string, number> | null {
  if (!ehObj(v)) return null;

  const saida: Record<string, number> = {};

  for (const [chave, valor] of Object.entries(v)) {
    if (!ehNum(valor)) return null;
    saida[chave] = valor;
  }

  return saida;
}

function lerContagens<K extends string>(v: unknown, chaves: readonly K[]): Record<K, number> | null {
  if (!ehObj(v)) return null;

  const saida = {} as Record<K, number>;

  for (const chave of chaves) {
    const valor = v[chave];

    if (!ehNum(valor)) return null;
    saida[chave] = valor;
  }

  return saida;
}

const TEXTOS_ANULAVEIS = [
  "operation_type",
  "document_type",
  "source_format",
  "document_number",
  "series",
  "access_key",
  "issuer_name",
  "issuer_cnpj",
  "reference",
  "issue_date",
  "applied_at",
  "last_error",
] as const;

function lerLinha(v: unknown): LinhaDocumento | null {
  if (!ehObj(v)) return null;
  if (typeof v.id !== "string" || typeof v.file_name !== "string") return null;
  if (typeof v.status !== "string" || typeof v.created_at !== "string") return null;
  if (!ehNum(v.unidades) || !ehNum(v.valor)) return null;
  if (!numOuNulo(v.total_items) || !numOuNulo(v.resolved_items)) return null;

  for (const campo of TEXTOS_ANULAVEIS) {
    if (!textoOuNulo(v[campo])) return null;
  }

  return {
    id: v.id,
    file_name: v.file_name,
    status: v.status,
    operation_type: v.operation_type as string | null,
    document_type: v.document_type as string | null,
    source_format: v.source_format as string | null,
    document_number: v.document_number as string | null,
    series: v.series as string | null,
    access_key: v.access_key as string | null,
    issuer_name: v.issuer_name as string | null,
    issuer_cnpj: v.issuer_cnpj as string | null,
    reference: v.reference as string | null,
    issue_date: v.issue_date as string | null,
    total_items: v.total_items,
    resolved_items: v.resolved_items,
    unidades: v.unidades,
    valor: v.valor,
    created_at: v.created_at,
    applied_at: v.applied_at as string | null,
    last_error: v.last_error as string | null,
  };
}

/** `null` = resposta fora do contrato. A tela recusa em vez de mostrar pedaço. */
export function lerVisaoDocumentos(dado: unknown): VisaoDocumentos | null {
  if (!ehObj(dado) || !ehNum(dado.total) || !Array.isArray(dado.linhas)) return null;
  if (!ehObj(dado.contagens)) return null;

  const estado = lerMapa(dado.contagens.estado);
  const direcao = lerMapa(dado.contagens.direcao);
  const tipo = lerMapa(dado.contagens.tipo);

  if (estado === null || direcao === null || tipo === null) return null;

  const resumo = lerContagens(dado.resumo, [
    "total",
    "em_conferencia",
    "em_leitura",
    "falhas",
    "aplicados_30d",
    "entradas_30d",
    "saidas_30d",
    "itens_sem_vinculo",
  ] as const);

  if (resumo === null) return null;

  const linhas: LinhaDocumento[] = [];

  for (const item of dado.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return { total: dado.total, linhas, contagens: { estado, direcao, tipo }, resumo };
}

/** Linha da leitura antiga (PostgREST em `documents`), enquanto a migration não chega ao banco. */
export interface LinhaDocumentoLegado {
  id: string;
  file_name: string;
  status: string;
  operation_type: string | null;
  document_number: string | null;
  series: string | null;
  access_key: string | null;
  issuer_name: string | null;
  issue_date: string | null;
  total_items: number | null;
  resolved_items: number | null;
  created_at: string;
  applied_at: string | null;
  last_error: string | null;
}

/**
 * A leitura antiga na forma nova. O que ela não sabe fica NULO — tipo, formato
 * e referência não existem antes da migration —, e unidades e valor ficam em
 * zero porque a tela os esconde quando o documento não foi lido pela RPC nova.
 */
export function linhaDoLegado(row: LinhaDocumentoLegado): LinhaDocumento {
  return {
    ...row,
    document_type: null,
    source_format: null,
    issuer_cnpj: null,
    reference: null,
    unidades: 0,
    valor: 0,
  };
}

/**
 * O próximo passo do documento — a coluna que responde "e agora?" sem abrir.
 *
 * É a mesma ideia de `proximoPasso` em `purchase-orders-overview.ts`: a tela
 * não repete o estado em palavras diferentes, ela diz o que falta fazer.
 */
export function proximoPassoDoDocumento(linha: LinhaDocumento): { texto: string; tom: "ok" | "atencao" | "perigo" | "info" | "neutro" } {
  const total = linha.total_items ?? 0;
  const resolvidos = linha.resolved_items ?? 0;
  const faltam = Math.max(total - resolvidos, 0);

  if (linha.status === "FAILED") return { texto: "Ver o que falhou", tom: "perigo" };
  if (linha.status === "APPLIED") return { texto: "Ver movimentos", tom: "ok" };
  if (linha.status === "CANCELLED") return { texto: "Cancelado", tom: "neutro" };
  if (linha.status === "UPLOADED" || linha.status === "PARSING") return { texto: "Lendo o arquivo…", tom: "info" };
  if (linha.status === "APPLYING") return { texto: "Aplicando…", tom: "info" };

  // PARSED: é aqui que a pessoa trabalha.
  if (linha.document_type === "ENVIO_FULL_ML_PDF") {
    return { texto: "Full · sem baixa", tom: "neutro" };
  }

  if (faltam > 0) {
    return { texto: `Vincular ${String(faltam)} de ${String(total)}`, tom: "atencao" };
  }

  return { texto: total === 0 ? "Nenhum item lido" : "Conferido · aplicar", tom: total === 0 ? "perigo" : "ok" };
}
