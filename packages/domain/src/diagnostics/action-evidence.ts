/**
 * Leitura defensiva de `actions.evidence` (D-064).
 *
 * `evidence` é `jsonb` gravado pelo worker com `service_role`, sem schema no
 * banco e sem contrato compartilhado com a interface. Cada `kind` de ação
 * escreve uma forma diferente: `venda_anomala` (D-064) traz direção, z-score e
 * causas candidatas; `reclamacoes_recorrentes` (D-116) não traz nenhum desses.
 *
 * A Central de Ações lia essa coluna com um cast direto para a forma da
 * anomalia de venda e acessava `causas_candidatas.length` sem guarda — a
 * primeira ação de SAC a nascer derrubaria a rota inteira (não há `error.tsx`
 * em `apps/web`). O `kind` sequer era consultado.
 *
 * Este módulo é a fronteira: uma função TOTAL, que nunca lança, para qualquer
 * `kind` e qualquer payload. Um `kind` novo criado no worker degrada para uma
 * linha sem direção e sem causas — nunca para uma tela quebrada.
 *
 * Morava em `apps/web/lib` até D-155, quando a `apps/api` virou o segundo
 * consumidor (`narrate_action` monta o prompt de narração a partir da MESMA
 * leitura que a tela renderiza) — a regra de contenção de
 * `docs/ARCHITECTURE.md` secao 7 manda subir para package exatamente nesse
 * momento. Dois leitores independentes do mesmo `jsonb` divergiriam na
 * primeira forma nova, e a narração citaria evidência que a tela não mostra.
 */

export interface ActionEvidenceItem {
  readonly tipo: string;
  readonly descricao: string;
}

export interface ActionCandidateCause {
  readonly eventType: string;
  readonly occurredAt: string;
  readonly descricao: string;
}

/** Problema e oportunidade são o mesmo objeto com sinal invertido (D-064). */
export type ActionTone = "problema" | "oportunidade" | "neutro";

export interface ActionEvidenceView {
  readonly kindLabel: string;
  /** `null` quando o `kind` não tem direção — nunca "Alta" por omissão. */
  readonly direcaoLabel: string | null;
  readonly tone: ActionTone;
  readonly evidencias: readonly ActionEvidenceItem[];
  readonly causas: readonly ActionCandidateCause[];
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  venda_anomala: "Venda anômala",
  reclamacoes_recorrentes: "Reclamações recorrentes",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];

  return typeof value === "string" && value !== "" ? value : null;
}

function readEvidencias(raw: unknown): ActionEvidenceItem[] {
  if (!isRecord(raw) || !Array.isArray(raw.evidencias)) return [];

  const items: ActionEvidenceItem[] = [];

  for (const entry of raw.evidencias) {
    if (!isRecord(entry)) continue;

    const descricao = readString(entry, "descricao");

    if (descricao === null) continue;

    items.push({ tipo: readString(entry, "tipo") ?? "evidencia", descricao });
  }

  return items;
}

function readCausas(raw: unknown): ActionCandidateCause[] {
  if (!isRecord(raw) || !Array.isArray(raw.causas_candidatas)) return [];

  const causes: ActionCandidateCause[] = [];

  for (const entry of raw.causas_candidatas) {
    if (!isRecord(entry)) continue;

    const descricao = readString(entry, "descricao");

    if (descricao === null) continue;

    causes.push({
      eventType: readString(entry, "event_type") ?? "desconhecido",
      occurredAt: readString(entry, "occurred_at") ?? "",
      descricao,
    });
  }

  return causes;
}

/**
 * `direcao` só é reconhecida nos dois valores que `diagnoseSalesAnomaly`
 * produz. Qualquer outra coisa — ausente, nula, texto novo — vira `null`, e a
 * tela mostra "—". Tratar ausência como "alta" diria que a venda subiu.
 */
function readDirecao(raw: unknown): "queda" | "alta" | null {
  if (!isRecord(raw)) return null;

  const direcao = raw.direcao;

  if (direcao === "queda" || direcao === "alta") return direcao;

  return null;
}

function toneFor(kind: string, direcao: "queda" | "alta" | null): ActionTone {
  if (direcao === "queda") return "problema";
  if (direcao === "alta") return "oportunidade";

  // Sem direção, o `kind` decide. Padrão de reclamação é problema por
  // definição; um `kind` desconhecido não recebe cor que afirme nada.
  return kind === "reclamacoes_recorrentes" ? "problema" : "neutro";
}

export function describeActionEvidence(kind: string, raw: unknown): ActionEvidenceView {
  const direcao = readDirecao(raw);

  return {
    kindLabel: KIND_LABELS[kind] ?? kind,
    direcaoLabel: direcao === null ? null : direcao === "queda" ? "Queda" : "Alta",
    tone: toneFor(kind, direcao),
    evidencias: readEvidencias(raw),
    causas: readCausas(raw),
  };
}
