import { describe, expect, it } from "vitest";

import {
  classifyJobFreshness,
  classifyResourceFreshness,
  failureRateLabel,
  JOB_CADENCE_MIN,
} from "./sync-health";

const NOW = new Date("2026-08-30T12:00:00Z");

function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

describe("classifyResourceFreshness", () => {
  it("orders (cadência horária): ok até 2h, atenção até 4h, crítico depois", () => {
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(30), NOW)).toBe("ok");
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(119), NOW)).toBe("ok");
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(180), NOW)).toBe("atencao");
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(300), NOW)).toBe("critico");
  });

  /**
   * O caso que derrubou a ideia de reusar a fórmula de pedidos: visits roda
   * UMA vez por dia. Com os limiares de orders, 20 horas desde o último
   * sucesso seria "crítico" — para uma sincronização funcionando exatamente
   * como projetada.
   */
  it("visits (cadência diária): 20h atrás é OK, não crítico", () => {
    expect(classifyResourceFreshness("visits", "reconciliation", minutesAgo(20 * 60), NOW)).toBe("ok");
    expect(classifyResourceFreshness("visits", "reconciliation", minutesAgo(3 * 1440), NOW)).toBe("atencao");
    expect(classifyResourceFreshness("visits", "reconciliation", minutesAgo(5 * 1440), NOW)).toBe("critico");
  });

  it("messages (10 min): degrada rápido, como deve", () => {
    expect(classifyResourceFreshness("messages", "reconciliation", minutesAgo(15), NOW)).toBe("ok");
    expect(classifyResourceFreshness("messages", "reconciliation", minutesAgo(35), NOW)).toBe("atencao");
    expect(classifyResourceFreshness("messages", "reconciliation", minutesAgo(60), NOW)).toBe("critico");
  });

  /**
   * Backfill é finito: "não rodou nas últimas 24h" é o estado NORMAL de um
   * backfill concluído. Carimbar frescor nele faria a tela gritar sobre o
   * comportamento certo — o defeito que o filtro `channel=reconciliation` da
   * tela antiga já existia para evitar (achado de produção de 2026-08-22).
   */
  it("backfill nunca ganha veredito de frescor", () => {
    expect(classifyResourceFreshness("orders", "backfill", minutesAgo(10_000), NOW)).toBe("sem_cadencia");
  });

  it("recurso sem cadência mapeada não ganha veredito chutado", () => {
    expect(classifyResourceFreshness("recurso_novo", "reconciliation", minutesAgo(5), NOW)).toBe("sem_cadencia");
  });

  it("sem sucesso nenhum é 'nunca', não crítico", () => {
    expect(classifyResourceFreshness("orders", "reconciliation", null, NOW)).toBe("nunca");
  });
});

describe("failureRateLabel", () => {
  /** O caso real medido em 2026-08-30: visits com 85% de falha por 429. */
  it("nomeia a taxa quando há falha", () => {
    expect(failureRateLabel(20, 17)).toBe("17 de 20 execuções falharam (85%)");
  });

  it("zero falha ou zero execução não produz alerta", () => {
    expect(failureRateLabel(24, 0)).toBeNull();
    expect(failureRateLabel(0, 0)).toBeNull();
  });
});

describe("classifyJobFreshness (Saúde do Sistema, D-219)", () => {
  /**
   * O CASO DO INCIDENTE, virado teste.
   *
   * Em D-217 `sync.orders.window` — job HORÁRIO — ficou 13 horas mudo e a
   * tela não disse nada, porque o limiar era um só e valia 26 horas para
   * todos. Treze horas é catástrofe para ele.
   */
  it("job horário calado por 13h é CRÍTICO — era o que 26h deixava passar", () => {
    expect(classifyJobFreshness("sync.orders.window", minutesAgo(13 * 60), NOW)).toBe("critico");
    // E já era crítico bem antes: mais de 4 ciclos.
    expect(classifyJobFreshness("sync.orders.window", minutesAgo(5 * 60), NOW)).toBe("critico");
    expect(classifyJobFreshness("sync.orders.window", minutesAgo(3 * 60), NOW)).toBe("atencao");
    expect(classifyJobFreshness("sync.orders.window", minutesAgo(90), NOW)).toBe("ok");
  });

  /**
   * A outra metade, e é o que impede a correção de virar alarme falso: as
   * MESMAS 13 horas são normais num job diário. Um limiar único erra nas duas
   * direções — passa o que importa e grita o que está certo.
   */
  it("as mesmas 13h num job diário são OK", () => {
    expect(classifyJobFreshness("sync.listing-visits.snapshot", minutesAgo(13 * 60), NOW)).toBe("ok");
    expect(classifyJobFreshness("maintenance.check-ai-budget", minutesAgo(13 * 60), NOW)).toBe("ok");
  });

  it("job de 10 minutos fica crítico em menos de uma hora", () => {
    expect(classifyJobFreshness("sync.support.questions.reconcile", minutesAgo(15), NOW)).toBe("ok");
    expect(classifyJobFreshness("sync.support.questions.reconcile", minutesAgo(30), NOW)).toBe("atencao");
    expect(classifyJobFreshness("sync.support.questions.reconcile", minutesAgo(60), NOW)).toBe("critico");
  });

  /**
   * Job movido por evento e RARO por natureza não tem cadência, e inventar uma
   * seria gritar sobre o comportamento certo — a decisão que D-143 tomou para
   * backfill. Este teste dizia o mesmo dos jobs de webhook; D-232 mediu que o
   * de pedidos processa ~4.600 execuções por dia com intervalo máximo de 61
   * minutos na semana, e o tirou daqui (ver o teste seguinte).
   */
  it("job sem cadência fixa e raro por natureza não ganha veredito", () => {
    for (const semCadencia of ["analytics.recompute", "backfill.orders", "erp.import.apply"]) {
      expect(classifyJobFreshness(semCadencia, minutesAgo(9999), NOW)).toBe("sem_cadencia");
    }
  });

  /**
   * Silêncio de job por evento (D-232): a unidade é o MAIOR intervalo
   * observado em 7 dias (61 min para o webhook de pedidos), e a escada é a do
   * módulo — até 2× é normal, até 4× atenção, acima crítico.
   */
  it("webhook de pedidos: mudo há 1 h é normal, há 3 h é atenção, há 5 h é crítico — e nunca rodou é `nunca`", () => {
    expect(classifyJobFreshness("sync.webhook.received", minutesAgo(60), NOW)).toBe("ok");
    expect(classifyJobFreshness("sync.webhook.received", minutesAgo(180), NOW)).toBe("atencao");
    expect(classifyJobFreshness("sync.webhook.received", minutesAgo(300), NOW)).toBe("critico");
    expect(classifyJobFreshness("sync.webhook.received", null, NOW)).toBe("nunca");
  });

  it("webhooks de perguntas e mensagens têm o SEU intervalo medido — 10 horas mudos ainda é normal", () => {
    expect(classifyJobFreshness("sync.support.questions", minutesAgo(600), NOW)).toBe("ok");
    expect(classifyJobFreshness("sync.support.messages", minutesAgo(600), NOW)).toBe("ok");
    expect(classifyJobFreshness("sync.support.questions", minutesAgo(50 * 60), NOW)).toBe("critico");
  });

  it("job agendado que nunca rodou é `nunca`, não `ok`", () => {
    expect(classifyJobFreshness("sync.orders.window", null, NOW)).toBe("nunca");
  });

  /**
   * O elo com a infraestrutura: todo job do mapa tem cadência positiva, e o
   * comentário ao lado de cada um nomeia o scheduler que a define
   * (`infra/cloud-scheduler.sh`). Um valor zerado ou negativo tornaria o
   * veredito sempre crítico, em silêncio.
   */
  it("toda cadência mapeada é positiva", () => {
    const invalidas = Object.entries(JOB_CADENCE_MIN).filter(([, min]) => !(min > 0));

    expect(invalidas).toEqual([]);
  });
});
