import { EVENT_SEVERITY } from "@sb/domain";
import { describe, expect, it } from "vitest";

import { eventTypeLabel } from "./labels.js";

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
