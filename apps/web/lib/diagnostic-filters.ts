/**
 * Filtros e seleção do Diagnóstico (`/diagnostico`, D22), puros e testáveis
 * sem React nem banco.
 *
 * **A seleção mora na URL** (`?sku=`), não em estado React — o frame é
 * mestre-detalhe, e sem isso o link para uma anomalia específica não existiria
 * e o voltar do navegador não funcionaria. É a mesma regra dos filtros de todas
 * as telas desta frente.
 *
 * **Só há UM filtro, e a ausência do outro é achado, não esquecimento.** O
 * frame põe dois menus na barra: "Todas as contas" e "Alta confiança". O
 * segundo existe — `confianca` é campo do contrato de diagnóstico
 * (`@sb/domain/diagnostics`). O primeiro **não tem predicado**: o diagnóstico é
 * por SKU, e `get_sku_sales_baseline` não recebe conta nem a conhece. Um menu
 * de conta aqui seria um controle que não recorta nada.
 */

/**
 * `DiagnosisConfidence` do domínio tem DOIS valores, não três: `media` e
 * `alta`, por limiar de z-score (|z| >= 2 é anomalia, |z| >= 3 sobe a
 * confiança). O frame sugere uma escala mais fina ("Alta · 91%"); ela não
 * existe, e o percentual não tem fonte.
 */
export const CONFIDENCE_KEYS = ["todas", "alta", "media"] as const;

export type ConfidenceKey = (typeof CONFIDENCE_KEYS)[number];

export interface DiagnosticFilters {
  confidence: ConfidenceKey;
  /** SKU selecionado no mestre-detalhe. `null` = a tela escolhe a primeira. */
  selectedSkuId: string | null;
}

export function resolveConfidence(raw: unknown): ConfidenceKey {
  if (typeof raw !== "string") return "todas";

  return (CONFIDENCE_KEYS as readonly string[]).includes(raw) ? (raw as ConfidenceKey) : "todas";
}

export function resolveDiagnosticFilters(
  query: Record<string, string | string[] | undefined>,
): DiagnosticFilters {
  return {
    confidence: resolveConfidence(query.confianca),
    selectedSkuId: typeof query.sku === "string" && query.sku.trim() !== "" ? query.sku.trim() : null,
  };
}

export function buildDiagnosticHref(
  current: DiagnosticFilters,
  override: Partial<DiagnosticFilters>,
): string {
  const next = { ...current, ...override };
  const search = new URLSearchParams();

  // O default fica FORA da URL: `/diagnostico` limpo continua sendo a mesma
  // página de sempre.
  if (next.confidence !== "todas") search.set("confianca", next.confidence);
  if (next.selectedSkuId !== null) search.set("sku", next.selectedSkuId);

  const qs = search.toString();

  return qs === "" ? "/diagnostico" : `/diagnostico?${qs}`;
}

/**
 * Aplica o recorte de confiança a diagnósticos JÁ calculados.
 *
 * Filtrar em memória aqui não é a agregação que `AGENTS.md` proíbe: `confianca`
 * é derivada em TypeScript a partir do baseline que já veio do banco
 * (`diagnoseSalesAnomaly`), então não há leitura a acrescentar — é o mesmo
 * conjunto, recortado.
 */
export function filterByConfidence<T extends { readonly confianca: "media" | "alta" }>(
  diagnoses: readonly T[],
  confidence: ConfidenceKey,
): readonly T[] {
  if (confidence === "todas") return diagnoses;

  return diagnoses.filter((d) => d.confianca === confidence);
}

/**
 * Qual anomalia o detalhe mostra.
 *
 * Sem `?sku=`, a PRIMEIRA da lista — que já vem ordenada por |z| decrescente,
 * então o detalhe abre na anomalia mais forte. Com um `sku` que não está no
 * recorte (filtro mudou, link velho), também cai na primeira em vez de mostrar
 * painel vazio: a tela nunca fica sem detalhe tendo o que mostrar.
 */
export function selectDiagnosis<T extends { readonly escopo: { readonly skuId: string } }>(
  diagnoses: readonly T[],
  selectedSkuId: string | null,
): T | null {
  if (diagnoses.length === 0) return null;

  const escolhido =
    selectedSkuId === null ? undefined : diagnoses.find((d) => d.escopo.skuId === selectedSkuId);

  return escolhido ?? diagnoses[0] ?? null;
}
