/**
 * A leitura de `get_suppliers_overview` (D-366) e as peças puras da tela
 * `/fornecedores` — sem React e sem banco, para ser testável.
 *
 * A RPC devolve `jsonb`, que o gerador declara como `Json`. Um `as` aceitaria
 * qualquer coisa, e um campo renomeado no SQL chegaria como `undefined` e sairia
 * "—" na tela, que se lê como "não observado" (D-131). Cada campo é conferido,
 * e uma resposta fora do contrato é recusada INTEIRA — o desenho de
 * `lib/replenishment-overview.ts`.
 *
 * Nada aqui soma: contagens e valores vêm do SQL.
 */

export interface LinhaFornecedor {
  readonly id: string;
  readonly name: string;
  readonly legal_name: string | null;
  readonly document: string | null;
  readonly contact_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly website: string | null;
  /** D-370. Ausente na resposta (banco sem a migration) = sem logo, nunca recusa. */
  readonly logo_path: string | null;
  readonly is_active: boolean;
  readonly orders_total: number;
  readonly orders_em_aberto: number;
  readonly ultimo_pedido_em: string | null;
  /** NULO com itens e nenhum custo — ausência não é zero (D-254/D-258). */
  readonly valor_pedido: number | null;
  readonly itens_sem_custo: number;
  readonly valor_em_aberto: number | null;
  readonly itens_em_aberto_sem_custo: number;
  readonly skus_distintos: number;
}

export interface ContagensFornecedores {
  readonly todos: number;
  readonly ativos: number;
  readonly inativos: number;
  readonly em_aberto: number;
  readonly sem_pedido: number;
}

export interface TotaisFornecedores {
  readonly pedidosEmAberto: number;
  readonly valorEmAberto: number | null;
  readonly itensEmAbertoSemCusto: number;
  readonly valorComprado: number | null;
  readonly itensSemCusto: number;
  readonly ultimoPedidoEm: string | null;
  readonly ultimoPedidoFornecedor: string | null;
}

export interface VisaoFornecedores {
  readonly total: number;
  readonly contagens: ContagensFornecedores;
  readonly totais: TotaisFornecedores;
  readonly linhas: readonly LinhaFornecedor[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

const TEXTOS_OPCIONAIS = ["legal_name", "document", "contact_name", "email", "phone", "whatsapp", "website"] as const;
const NUMEROS = [
  "orders_total",
  "orders_em_aberto",
  "itens_sem_custo",
  "itens_em_aberto_sem_custo",
  "skus_distintos",
] as const;

function lerLinha(v: unknown): LinhaFornecedor | null {
  if (!ehObj(v)) return null;
  if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.is_active !== "boolean") return null;
  if (!textoOuNulo(v.ultimo_pedido_em) || !numOuNulo(v.valor_pedido) || !numOuNulo(v.valor_em_aberto)) return null;
  if (TEXTOS_OPCIONAIS.some((campo) => !textoOuNulo(v[campo]))) return null;
  if (NUMEROS.some((campo) => !ehNum(v[campo]))) return null;
  // Opcional de propósito: a web chega ao ar antes da migration de D-370, e um
  // campo novo obrigatório recusaria a lista inteira (e a de /compras/novo).
  if (v.logo_path !== undefined && !textoOuNulo(v.logo_path)) return null;

  const texto = (campo: (typeof TEXTOS_OPCIONAIS)[number]): string | null => v[campo] as string | null;
  const numero = (campo: (typeof NUMEROS)[number]): number => v[campo] as number;

  return {
    id: v.id,
    name: v.name,
    legal_name: texto("legal_name"),
    document: texto("document"),
    contact_name: texto("contact_name"),
    email: texto("email"),
    phone: texto("phone"),
    whatsapp: texto("whatsapp"),
    website: texto("website"),
    logo_path: typeof v.logo_path === "string" ? v.logo_path : null,
    is_active: v.is_active,
    orders_total: numero("orders_total"),
    orders_em_aberto: numero("orders_em_aberto"),
    ultimo_pedido_em: v.ultimo_pedido_em,
    valor_pedido: v.valor_pedido,
    itens_sem_custo: numero("itens_sem_custo"),
    valor_em_aberto: v.valor_em_aberto,
    itens_em_aberto_sem_custo: numero("itens_em_aberto_sem_custo"),
    skus_distintos: numero("skus_distintos"),
  };
}

function lerContagens(v: unknown): ContagensFornecedores | null {
  if (!ehObj(v)) return null;

  const { todos, ativos, inativos, em_aberto, sem_pedido } = v;

  if (!ehNum(todos) || !ehNum(ativos) || !ehNum(inativos) || !ehNum(em_aberto) || !ehNum(sem_pedido)) return null;

  return { todos, ativos, inativos, em_aberto, sem_pedido };
}

function lerTotais(v: unknown): TotaisFornecedores | null {
  if (!ehObj(v)) return null;
  if (!ehNum(v.pedidos_em_aberto) || !ehNum(v.itens_em_aberto_sem_custo) || !ehNum(v.itens_sem_custo)) return null;
  if (!numOuNulo(v.valor_em_aberto) || !numOuNulo(v.valor_comprado)) return null;
  if (!textoOuNulo(v.ultimo_pedido_em) || !textoOuNulo(v.ultimo_pedido_fornecedor)) return null;

  return {
    pedidosEmAberto: v.pedidos_em_aberto,
    valorEmAberto: v.valor_em_aberto,
    itensEmAbertoSemCusto: v.itens_em_aberto_sem_custo,
    valorComprado: v.valor_comprado,
    itensSemCusto: v.itens_sem_custo,
    ultimoPedidoEm: v.ultimo_pedido_em,
    ultimoPedidoFornecedor: v.ultimo_pedido_fornecedor,
  };
}

/** `null` = resposta fora do contrato. A tela recusa em vez de mostrar pedaço. */
export function lerVisaoFornecedores(dado: unknown): VisaoFornecedores | null {
  if (!ehObj(dado) || !ehNum(dado.total) || !Array.isArray(dado.linhas)) return null;

  const contagens = lerContagens(dado.contagens);
  const totais = lerTotais(dado.totais);

  if (contagens === null || totais === null) return null;

  const linhas: LinhaFornecedor[] = [];

  for (const item of dado.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return { total: dado.total, contagens, totais, linhas };
}

// ---------------------------------------------------------------------------
// Contato: o cadastro é texto livre, e a tela transforma em ação só o que é
// inequívoco. O que não dá para interpretar continua texto, nunca link morto.
// ---------------------------------------------------------------------------

const soDigitos = (valor: string): string => valor.replace(/\D/g, "");

/**
 * `https://wa.me/55…` a partir do WhatsApp cadastrado. Número brasileiro sem
 * DDI (10 ou 11 dígitos, com DDD) ganha o 55; com DDI (12 ou 13 começando em
 * 55) fica como está. Qualquer outra forma não vira link: um número errado
 * abriria a conversa com outra pessoa.
 */
export function linkWhatsapp(valor: string | null): string | null {
  if (valor === null) return null;

  const digitos = soDigitos(valor).replace(/^0+/, "");

  if (digitos.length === 10 || digitos.length === 11) return `https://wa.me/55${digitos}`;
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")) return `https://wa.me/${digitos}`;

  return null;
}

/** `tel:` só com número que tenha ao menos DDD + número (10 dígitos). */
export function linkTelefone(valor: string | null): string | null {
  if (valor === null) return null;

  const digitos = soDigitos(valor);

  return digitos.length >= 10 && digitos.length <= 13
    ? `tel:+${digitos.length <= 11 ? `55${digitos}` : digitos}`
    : null;
}

export function linkEmail(valor: string | null): string | null {
  if (valor === null) return null;

  const email = valor.trim();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `mailto:${email}` : null;
}

/** Site sem protocolo ganha `https://`; o que não parece domínio não vira link. */
export function linkSite(valor: string | null): string | null {
  if (valor === null) return null;

  const site = valor.trim();

  if (site === "" || /\s/.test(site)) return null;

  const comProtocolo = /^https?:\/\//i.test(site) ? site : `https://${site}`;

  try {
    const url = new URL(comProtocolo);

    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** "loja.com.br" em vez de "https://www.loja.com.br/" — o rótulo curto do link. */
export function rotuloSite(valor: string): string {
  return valor
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/**
 * CNPJ e CPF com a pontuação de sempre. O cadastro guarda como veio (com ou sem
 * pontos); só 14 ou 11 dígitos são formatados, o resto aparece como está.
 */
export function formatarDocumento(valor: string | null): string | null {
  if (valor === null) return null;

  const d = soDigitos(valor);

  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;

  return valor.trim();
}

/** As iniciais do avatar: "Navetec Distribuidora" → "ND". */
export function iniciais(nome: string): string {
  const partes = nome
    .trim()
    .split(/\s+/)
    .filter((p) => /[\p{L}\p{N}]/u.test(p));

  if (partes.length === 0) return "?";

  const primeira = partes[0]?.[0] ?? "";
  const segunda = partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? "") : (partes[0]?.[1] ?? "");

  return `${primeira}${segunda}`.toUpperCase();
}

/** "hoje", "ontem", "há 5 dias", "há 3 meses" — a idade do último pedido. */
export function idadeRelativa(instante: string | null, agora: Date): string | null {
  if (instante === null) return null;

  const dias = Math.floor((agora.getTime() - new Date(instante).getTime()) / 86_400_000);

  if (dias <= 0) return "hoje";
  if (dias === 1) return "ontem";
  if (dias < 30) return `há ${String(dias)} dias`;

  const meses = Math.floor(dias / 30);

  if (meses < 12) return meses === 1 ? "há 1 mês" : `há ${String(meses)} meses`;

  const anos = Math.floor(dias / 365);

  return anos <= 1 ? "há 1 ano" : `há ${String(anos)} anos`;
}
