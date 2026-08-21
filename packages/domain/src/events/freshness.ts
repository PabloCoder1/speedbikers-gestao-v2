/**
 * Classificação de frescor de sincronização — a regra pura por trás da Tela
 * de Saúde da Sincronização (`docs/ROADMAP.md`, Fase 3).
 *
 * `docs/ARCHITECTURE.md` secao 20: "`sync_runs`/`sync_errors`/freshness por
 * conta vira a tela de Saúde da Sincronização, que é observabilidade PARA O
 * USUÁRIO." A reconciliação por janela roda no máximo uma vez por hora
 * (`docs/HANDOFF.md`) — os limiares abaixo dão folga a essa cadência antes
 * de soar alarme, e não são métrica do catálogo oficial (`docs/API.md`
 * secao 4 só define `sync.delayed`/`sync.failed` como eventos, ainda não
 * implementados): é a mesma noção, calculada direto de `sync_runs` sem
 * depender de um evento que ainda não existe.
 */

export type FreshnessLevel = "ok" | "atencao" | "critico" | "nunca_sincronizado";

const OK_MS = 3 * 60 * 60 * 1000;
const ATENCAO_MS = 12 * 60 * 60 * 1000;

/**
 * `latestRecordAt` nulo significa que nunca houve um `sync_run` bem-sucedido
 * que tenha efetivamente trazido dado novo para esta conta/recurso — pode
 * ser conta recém-conectada com backfill ainda em andamento, não é
 * necessariamente erro.
 */
export function classifySyncFreshness(latestRecordAt: Date | null, now: Date): FreshnessLevel {
  if (latestRecordAt === null) {
    return "nunca_sincronizado";
  }

  const ageMs = now.getTime() - latestRecordAt.getTime();

  if (ageMs <= OK_MS) {
    return "ok";
  }

  if (ageMs <= ATENCAO_MS) {
    return "atencao";
  }

  return "critico";
}
