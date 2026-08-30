/**
 * Diagnóstico e Central de Ações (Fase 6, `docs/ARCHITECTURE.md` secao 16) —
 * primeira peça: "Baseline, desvio e detecção estatística sem machine
 * learning". Pipeline: `janela+escopo -> coleta de sinais -> baseline e
 * desvio (SQL, get_sku_sales_baseline) -> candidatos a causa correlacionados
 * com domain_events datados -> confiança calculada por regra` — tudo AQUI,
 * puro, sem IA (que só narraria no fim, Fase 7, fora de escopo).
 *
 * `get_sku_sales_baseline` já filtra amostra mínima e traz os números
 * agregados (`docs/ARCHITECTURE.md` secao 21: zero agregação em JS) — esta
 * função só INTERPRETA um sinal já pronto, a mesma divisão de trabalho de
 * `computeLedgerIntegrityDivergences` (SQL recomputa, TS decide o que é
 * divergência/anomalia).
 */

export interface SalesBaselineSignal {
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
  /** `extract(dow from ...)`: 0 = domingo .. 6 = sábado. */
  readonly weekday: number;
  readonly currentUnitsSold: number;
  readonly baselineMean: number;
  readonly baselineStddev: number;
  readonly sampleCount: number;
}

export interface CorrelatedEvent {
  readonly eventType: string;
  readonly occurredAt: Date;
}

export type AnomalyDirection = "queda" | "alta";
export type DiagnosisConfidence = "media" | "alta";

export interface DiagnosisEvidence {
  readonly tipo: string;
  readonly descricao: string;
}

export interface DiagnosisCandidateCause {
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly descricao: string;
}

/**
 * Contrato de saída fixo (`docs/ARCHITECTURE.md` secao 16): `{ evidencias[],
 * causas_candidatas[], confianca, escopo, periodo, proximos_passos[] }` —
 * nomes de campo em português/snake_case no documento, mapeados aqui para
 * camelCase (convenção do resto do domínio) sem mudar o formato.
 */
export interface SalesAnomalyDiagnosis {
  readonly escopo: { readonly organizationId: string; readonly skuId: string };
  readonly periodo: { readonly asOf: string };
  readonly direcao: AnomalyDirection;
  readonly confianca: DiagnosisConfidence;
  readonly zScore: number;
  /** `currentUnitsSold - baselineMean` — negativo em queda, positivo em alta. Insumo de `estimateImpactBrl`. */
  readonly unitsDelta: number;
  readonly evidencias: readonly DiagnosisEvidence[];
  readonly causasCandidatas: readonly DiagnosisCandidateCause[];
  readonly proximosPassos: readonly string[];
}

/** |z| >= 2 é o limiar de anomalia (regra própria "sem machine learning", ARCHITECTURE.md secao 16); |z| >= 3 sobe a confiança. */
const ANOMALY_Z_THRESHOLD = 2;
const HIGH_CONFIDENCE_Z_THRESHOLD = 3;

function describeCandidateCause(eventType: string): string {
  switch (eventType) {
    case "stock.depleted":
      return "Estoque zerou perto desta data — pode explicar a queda.";
    case "stock.replenished":
      return "Estoque foi reposto perto desta data — pode explicar a retomada.";
    case "order.cancelled":
      return "Houve cancelamento de pedido perto desta data.";
    case "order.returned":
      return "Houve devolução perto desta data.";
    case "stock.balance.diverged":
      return "Divergência de saldo detectada perto desta data — o dado de estoque pode estar incorreto.";
    // Separado de `diverged` em D-135. A redação é deliberadamente mais
    // fraca: aqui o saldo JÁ foi corrigido contra o ERP na mesma execução,
    // então a evidência é "o número anterior estava errado", não "o número
    // está errado". Afirmar o segundo seria a IA herdando um alarme que o
    // próprio sistema já resolveu.
    case "stock.balance.adjusted":
      return "Saldo corrigido contra o ERP perto desta data — o estoque anterior a ela pode estar incorreto.";
    // D-152: os eventos de ANÚNCIO passaram a chegar à correlação (antes o
    // filtro entity_type='sku' os barrava) — são as causas clássicas de
    // virada na venda, e cada uma ganha a sua leitura.
    case "listing.price.changed":
      return "O preço de um anúncio deste SKU mudou perto desta data — causa clássica de virada na venda.";
    case "listing.title.changed":
      return "O título de um anúncio deste SKU mudou perto desta data — afeta busca e conversão.";
    case "listing.status.paused":
      return "Um anúncio deste SKU foi PAUSADO perto desta data — sem oferta ativa, sem venda por aquele canal.";
    case "listing.status.reactivated":
      return "Um anúncio deste SKU foi reativado perto desta data — pode explicar a retomada.";
    case "listing.fulfillment.entered":
      return "Um anúncio deste SKU entrou no Full perto desta data — muda logística e exposição.";
    default:
      return `Evento "${eventType}" registrado perto desta data.`;
  }
}

/**
 * Diagnostica UM sinal já agregado (`get_sku_sales_baseline`). Devolve
 * `null` quando não há anomalia (ou quando o sinal não é confiável o
 * bastante para julgar) — a ausência de diagnóstico é uma resposta válida,
 * não um erro.
 *
 * Guardas revalidadas aqui mesmo já filtradas em SQL: a função é o contrato
 * público de `@sb/domain/diagnostics` — correta sozinha, sem depender de
 * quem chama lembrar do `WHERE` da RPC.
 */
/**
 * Sinal de SAC para o diagnóstico (D-116) — reclamações ABERTAS vinculadas
 * ao SKU no momento da análise. Opcional e aditivo: chamadas existentes
 * seguem intactas.
 */
export interface SupportSignal {
  readonly openClaims: number;
}

export function diagnoseSalesAnomaly(
  organizationId: string,
  signal: SalesBaselineSignal,
  asOf: string,
  relatedEvents: readonly CorrelatedEvent[],
  supportSignal?: SupportSignal,
): SalesAnomalyDiagnosis | null {
  if (signal.sampleCount < 4) return null;
  if (signal.baselineMean <= 0) return null;
  if (signal.baselineStddev <= 0) return null;

  const zScore = (signal.currentUnitsSold - signal.baselineMean) / signal.baselineStddev;

  if (Math.abs(zScore) < ANOMALY_Z_THRESHOLD) return null;

  const direcao: AnomalyDirection = zScore < 0 ? "queda" : "alta";
  const confianca: DiagnosisConfidence = Math.abs(zScore) >= HIGH_CONFIDENCE_Z_THRESHOLD ? "alta" : "media";

  const evidencias: DiagnosisEvidence[] = [
    {
      tipo: "venda_vs_baseline",
      descricao:
        `${signal.sku} vendeu ${String(signal.currentUnitsSold)} unidade(s) — ` +
        `baseline de ${signal.baselineMean.toFixed(1)} ± ${signal.baselineStddev.toFixed(1)} ` +
        `(últimas ${String(signal.sampleCount)} ocorrências do mesmo dia da semana)`,
    },
  ];

  // SAC como evidência (D-116): reclamação aberta é FATO observado, não
  // conclusão — entra como evidência sempre, e como causa candidata SÓ na
  // QUEDA (reclamação não explica venda subindo). A regra do requisito
  // continua: sinal agregado, nunca palavra solta em mensagem.
  const openClaims = supportSignal?.openClaims ?? 0;

  if (openClaims > 0) {
    evidencias.push({
      tipo: "reclamacoes_abertas",
      descricao: `${String(openClaims)} reclamação(ões) aberta(s) vinculada(s) a este SKU no momento da análise.`,
    });
  }

  const causasCandidatas: DiagnosisCandidateCause[] = relatedEvents.map((event) => ({
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    descricao: describeCandidateCause(event.eventType),
  }));

  if (direcao === "queda" && openClaims > 0) {
    causasCandidatas.push({
      eventType: "support.claims.open",
      // O instante é o da ANÁLISE (asOf), não de um evento pontual — é um
      // estado observado, e a descrição deixa isso explícito.
      occurredAt: new Date(`${asOf}T00:00:00.000Z`),
      descricao: `${String(openClaims)} reclamação(ões) em aberto no SKU — problema de produto/atendimento pode estar derrubando a conversão.`,
    });
  }

  const proximosPassos: string[] =
    causasCandidatas.length > 0
      ? [
          "Revisar o evento correlato listado acima antes de agir.",
          ...(direcao === "queda" && openClaims > 0
            ? ["Abrir a Caixa de Entrada filtrada por este SKU e ler as reclamações."]
            : []),
        ]
      : ["Nenhum evento correlato encontrado — investigar preço, concorrência ou sazonalidade fora do baseline."];

  return {
    escopo: { organizationId, skuId: signal.skuId },
    periodo: { asOf },
    direcao,
    confianca,
    zScore: Math.round(zScore * 100) / 100,
    unitsDelta: signal.currentUnitsSold - signal.baselineMean,
    evidencias,
    causasCandidatas,
    proximosPassos,
  };
}

/**
 * Impacto financeiro estimado de um diagnóstico (Central de Ações, D-064):
 * `|unitsDelta| * preço médio`. Preço vem de `get_sku_average_prices`,
 * buscado só para os SKUs já confirmados como anomalia (evita N+1 no
 * catálogo inteiro) — por isso é uma função separada de
 * `diagnoseSalesAnomaly`, chamada depois, não durante.
 *
 * `null` quando não há preço médio no período (SKU sem venda registrada
 * com preço) — impacto desconhecido é diferente de impacto zero.
 */
export function estimateImpactBrl(unitsDelta: number, averagePrice: number | null): number | null {
  if (averagePrice === null) return null;
  return Math.round(Math.abs(unitsDelta) * averagePrice * 100) / 100;
}
