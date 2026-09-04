/**
 * Núcleo compartilhado dos filtros de tela (D-141) — o item "filtros
 * consistentes entre telas" da Fase 5C.
 *
 * **Extraído com dor medida, não por antecipação** (`docs/ARCHITECTURE.md`
 * §1): `pillStyle` estava copiado em CINCO telas (`/vendas`, `/anuncios`,
 * `/estoque`, `/curva-abc`, `/atendimento`), a construção de href com reset de
 * página em TRÊS, e o resumo da janela paginada em TRÊS. A regra de contenção
 * do projeto diz que algo vira peça compartilhada quando um segundo consumidor
 * aparece; aqui já eram cinco.
 *
 * O que NÃO entra aqui: a resolução dos filtros de cada tela. `marca` só
 * existe em `/estoque`, `criterio` só em `/curva-abc`, `vinculo` só em
 * `/anuncios`. Generalizar isso produziria um resolvedor que aceita qualquer
 * coisa e não valida nada — o oposto do que cada `resolve*` faz hoje, que é
 * recusar valor fora da lista fechada. Cada tela continua dona do seu
 * vocabulário; o que se compartilha é a mecânica.
 */

/**
 * Página 1 é o piso. Valor não numérico, zero, negativo ou fracionário cai em
 * 1 — `offset` negativo seria erro do Postgres, e a tela não pode exibir
 * "Página -3".
 */
export function resolvePageParam(raw: unknown): number {
  if (typeof raw !== "string") return 1;

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Monta a URL de um filtro preservando as demais dimensões.
 *
 * Chave com `null`/`undefined` é OMITIDA — é assim que o default fica fora da
 * URL e `/estoque` limpo continua sendo `/estoque`. Cada tela decide o que é
 * default antes de chamar, porque isso é vocabulário dela.
 *
 * `page` só aparece a partir da 2. Quem troca um filtro passa `1` de
 * propósito: manter o offset ao mudar o CONJUNTO mostraria uma página vazia
 * que o usuário lê como "nenhum resultado".
 */
export function buildFilterHref(
  basePath: string,
  params: Record<string, string | null | undefined>,
  page: number,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, value);
    }
  }

  if (page > 1) {
    search.set("pagina", String(page));
  }

  const qs = search.toString();

  return qs === "" ? basePath : `${basePath}?${qs}`;
}

export interface PagedWindow {
  label: string;
  totalPages: number;
}

/**
 * A frase que impede as telas de repetirem o truncamento silencioso.
 *
 * Motivo medido, três vezes na mesma sessão: `/anuncios` mostrava 1.000 de
 * 5.085 sem dizer nada (D-138); `/curva-abc` mostrava 1.000 de 1.492 e ainda
 * somava as classes A/B/C sobre esse recorte, exibindo classe C = 298 quando o
 * real era 790 (D-140). Em nenhum dos casos havia como distinguir "estes são
 * todos" de "estes são os primeiros N".
 *
 * `noun` traz as DUAS formas ("anúncio"/"anúncios", "SKU na curva"/"SKUs na
 * curva") e a função escolhe pelo total. Era uma string no plural, e três das
 * oito telas flexionavam por conta própria antes de chamar — as outras cinco
 * mostravam "1 anúncios." e ninguém via, porque um total de exatamente um é
 * raro em produção e nunca aparecia no seed. Exigir as duas formas no tipo faz
 * o compilador enumerar as telas em vez de deixar a quarta cópia do ternário
 * nascer. `trailing` é o complemento que só faz sentido quando há mais de uma
 * página (", em ordem de SKU"). Uma página só não recebe faixa: "1 a 12 de 12"
 * é ruído.
 */
export function summarizePagedWindow(input: {
  page: number;
  totalCount: number;
  rowsOnPage: number;
  pageSize: number;
  noun: { singular: string; plural: string };
  emptyLabel: string;
  trailing?: string;
}): PagedWindow {
  const { page, totalCount, rowsOnPage, pageSize, emptyLabel } = input;
  const trailing = input.trailing ?? "";

  if (totalCount === 0) {
    return { label: emptyLabel, totalPages: 0 };
  }

  const totalPages = Math.ceil(totalCount / pageSize);
  const formatted = new Intl.NumberFormat("pt-BR");
  // Flexiona pelo TOTAL, não pela página: "Mostrando 1 a 1 de 1 anúncio" e
  // "1 anúncio." são a mesma unidade, e é o total que a frase nomeia.
  const noun = totalCount === 1 ? input.noun.singular : input.noun.plural;

  if (totalPages === 1) {
    return { label: `${formatted.format(totalCount)} ${noun}.`, totalPages };
  }

  const first = (page - 1) * pageSize + 1;
  const last = first + rowsOnPage - 1;

  return {
    label: `Mostrando ${formatted.format(first)} a ${formatted.format(last)} de ${formatted.format(totalCount)} ${noun}${trailing}.`,
    totalPages,
  };
}
