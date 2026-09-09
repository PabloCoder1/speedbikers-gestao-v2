import { EVENT_SEVERITY } from "@sb/domain";
import { describe, expect, it } from "vitest";

import { eventTypeLabel, runStatusLabel } from "./labels.js";

/**
 * Todo tipo de evento tem rótulo (D-208).
 *
 * `/notificacoes/preferencias` monta a lista iterando
 * `Object.keys(EVENT_SEVERITY)`, e `lookup()` devolve o CÓDIGO CRU quando o
 * rótulo falta — então esquecer o rótulo não quebra nada: só põe
 * `order.return.unreversed` na frente do usuário, no meio de frases em
 * português. É a classe D-131 aplicada à interface, e foi um erro
 * disponível para mim nesta própria fatia: acrescentei o tipo ao catálogo de
 * severidade e o rótulo em arquivos diferentes, sem nada ligando os dois.
 *
 * Este teste é esse elo.
 */
describe("rótulos de domain_events", () => {
  it("todo event_type do catálogo de severidade tem rótulo em português", () => {
    const semRotulo = Object.keys(EVENT_SEVERITY).filter((tipo) => eventTypeLabel(tipo) === tipo);

    expect(semRotulo).toEqual([]);
  });
});

/**
 * O MESMO elo, para `sync_runs.status` (D-273).
 *
 * D-208 criou o teste acima porque `lookup()` devolve o código cru quando o
 * rótulo falta — e isso não quebra nada, só põe inglês de banco na frente da
 * pessoa. A tela de Sincronização mostrava exatamente isso: "done", minúsculo,
 * numa coluna chamada Status. O elo existia para um catálogo e não para os
 * outros.
 */
describe("rótulos de estado de execução (sync_runs e job_runs)", () => {
  it("os três status do check têm rótulo em português", () => {
    // `sync_runs_status_check`: done, failed, partial. `job_runs` usa os dois
    // primeiros (medido: são os únicos valores no Dev). Se o banco ganhar um
    // quarto, este teste continua verde — por isso a tela de Sincronização
    // também mostra o balde "Sem cadência", que é o detector do lado do dado.
    for (const status of ["done", "failed", "partial"]) {
      expect(runStatusLabel(status), status).not.toBe(status);
    }
  });

  it("status desconhecido devolve o código, sem inventar tradução", () => {
    expect(runStatusLabel("cancelled")).toBe("cancelled");
  });
});
