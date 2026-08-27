import { describe, expect, it } from "vitest";

import { claimMessagesSchema, claimSchema } from "./claim-schema.js";
import { mapClaimMessagesToProjection, mapClaimToSupportProjection } from "./claim-support-projection.js";

/**
 * Fixture VERBATIM do exemplo oficial de `GET /post-purchase/v1/claims/{id}`
 * (`developers.mercadolivre.com.br`, "Gerenciar reclamações", lido ao vivo em
 * 2026-08-27). Mesmo padrão de D-097: o contrato é provado contra o payload
 * publicado, não contra um objeto inventado pelo teste.
 *
 * Repare que este exemplo é a prova da correção de D-084 registrada em D-104:
 * `type: "mediations"` junto de `stage: "claim"`, encerrado pelo vendedor.
 */
const OFFICIAL_CLAIM = {
  id: 5256749420,
  resource_id: 2000007819609432,
  status: "closed",
  type: "mediations",
  stage: "claim",
  parent_id: null,
  resource: "order",
  reason_id: "PDD9549",
  fulfilled: true,
  quantity_type: "total",
  claimed_quantity: 1,
  claim_version: 2.0,
  players: [
    { role: "complainant", type: "buyer", user_id: 1325224382, available_actions: [] },
    { role: "respondent", type: "seller", user_id: 1330467461, available_actions: [] },
  ],
  resolution: {
    reason: "payment_refunded",
    date_created: "2024-03-21T05:19:22.000-04:00",
    benefited: ["complainant"],
    closed_by: "respondent",
    applied_coverage: false,
  },
  site_id: "MLB",
  date_created: "2024-03-14T08:28:44.000-04:00",
  last_updated: "2024-03-21T05:19:22.000-04:00",
  related_entities: [],
};

function parse(overrides: Record<string, unknown> = {}) {
  return claimSchema.parse({ ...OFFICIAL_CLAIM, ...overrides });
}

describe("claimSchema — payload oficial", () => {
  it("aceita o exemplo oficial verbatim, com os campos novos", () => {
    const claim = parse();

    expect(claim.stage).toBe("claim");
    expect(claim.last_updated).toBe("2024-03-21T05:19:22.000-04:00");
    expect(claim.resolution?.closed_by).toBe("respondent");
    expect(claim.players?.[0]?.user_id).toBe(1325224382);
  });

  it("aceita o payload MÍNIMO de D-057, sem nenhum campo novo", () => {
    // Regressão do caminho de estoque, que já roda em produção: exigir os
    // campos novos transformaria uma ausência em ZodError e derrubaria a
    // reversão de estoque. Mesma lição de D-101.
    const claim = claimSchema.parse({
      id: 42,
      resource: "order",
      resource_id: 99,
      status: "opened",
      type: "return",
      related_entities: ["return"],
    });

    expect(claim.stage).toBeUndefined();
    expect(claim.last_updated).toBeUndefined();
  });
});

describe("mapClaimToSupportProjection", () => {
  it("`type: mediations` com `stage: claim` NÃO é mediação (D-104 corrige D-084)", () => {
    const projection = mapClaimToSupportProjection(parse());

    expect(projection?.case.isMediation).toBe(false);
    expect(projection?.case.initialPriority).toBe("ALTA");
    expect(projection?.case.externalType).toBe("mediations");
  });

  it("`stage: dispute` é a mediação de verdade, e vira CRITICA", () => {
    const projection = mapClaimToSupportProjection(parse({ stage: "dispute" }));

    expect(projection?.case.isMediation).toBe(true);
    expect(projection?.case.initialPriority).toBe("CRITICA");
  });

  it("monta a identidade exigida pela constraint do banco", () => {
    const projection = mapClaimToSupportProjection(parse());

    expect(projection?.case.channel).toBe("CLAIM");
    expect(projection?.case.externalCaseId).toBe("5256749420");
    // `support_cases_external_key_coherent` exige exatamente esta forma.
    expect(projection?.case.externalCaseKey).toBe("claim:5256749420");
  });

  it("claim fechado nasce RESOLVIDO com a data real do encerramento", () => {
    const projection = mapClaimToSupportProjection(parse());

    expect(projection?.case.initialInternalStatus).toBe("RESOLVIDO");
    expect(projection?.case.initialResolvedAt).toBe("2024-03-21T05:19:22.000-04:00");
  });

  it("claim aberto nasce NOVO sem resolved_at", () => {
    const projection = mapClaimToSupportProjection(parse({ status: "opened", resolution: null }));

    expect(projection?.case.initialInternalStatus).toBe("NOVO");
    // `support_cases_resolution_coherent` rejeita RESOLVIDO sem data E
    // não-RESOLVIDO com data.
    expect(projection?.case.initialResolvedAt).toBeNull();
  });

  it("fechado sem `resolution.date_created` cai para lastActivityAt, nunca now()", () => {
    const projection = mapClaimToSupportProjection(parse({ resolution: null }));

    expect(projection?.case.initialResolvedAt).toBe("2024-03-21T05:19:22.000-04:00");
  });

  it("last_activity_at usa `last_updated`, e cai para `date_created` sem ele", () => {
    expect(mapClaimToSupportProjection(parse())?.case.lastActivityAt).toBe("2024-03-21T05:19:22.000-04:00");

    const semUpdate = mapClaimToSupportProjection(parse({ last_updated: null }));

    expect(semUpdate?.case.lastActivityAt).toBe("2024-03-14T08:28:44.000-04:00");
  });

  it("sem NENHUMA data do Mercado Livre devolve null em vez de inventar o instante", () => {
    // O defeito de D-097: usar o instante da consulta achata a ordenação
    // inteira da Caixa de Entrada. Não projetar é melhor.
    const projection = mapClaimToSupportProjection(parse({ last_updated: null, date_created: null }));

    expect(projection).toBeNull();
  });

  it("devolução é faceta, detectada por related_entities (não por type)", () => {
    expect(mapClaimToSupportProjection(parse())?.case.hasReturn).toBe(false);

    const comDevolucao = mapClaimToSupportProjection(parse({ related_entities: ["return"] }));

    expect(comDevolucao?.case.hasReturn).toBe(true);
  });

  it("mediação e devolução coexistem no MESMO case, nunca em dois", () => {
    const projection = mapClaimToSupportProjection(parse({ stage: "dispute", related_entities: ["return"] }));

    expect(projection?.case.isMediation).toBe(true);
    expect(projection?.case.hasReturn).toBe(true);
    expect(projection?.case.externalCaseKey).toBe("claim:5256749420");
  });

  it("o cliente é o COMPRADOR, achado por `type`, não por quem reclama", () => {
    // Em `cancel_purchase` quem reclama é o comprador; em `cancel_sale` é o
    // vendedor. Filtrar por `role: complainant` pegaria o vendedor às vezes.
    const projection = mapClaimToSupportProjection(
      parse({
        players: [
          { role: "complainant", type: "seller", user_id: 999, available_actions: [] },
          { role: "respondent", type: "buyer", user_id: 111, available_actions: [] },
        ],
      }),
    );

    expect(projection?.case.customerExternalId).toBe(111);
  });

  it("sem `players` o cliente é null e a resposta fica UNKNOWN", () => {
    const projection = mapClaimToSupportProjection(parse({ players: null }));

    expect(projection?.case.customerExternalId).toBeNull();
    expect(projection?.case.remoteReplyState).toBe("UNKNOWN");
  });

  it("resposta é ALLOWED só quando a ação oficial de mensagem existe", () => {
    const semAcao = mapClaimToSupportProjection(parse());

    expect(semAcao?.case.remoteReplyState).toBe("BLOCKED");

    const comAcao = mapClaimToSupportProjection(
      parse({
        players: [
          {
            role: "respondent",
            type: "seller",
            user_id: 1330467461,
            available_actions: [{ action: "send_message_to_complainant", mandatory: false, due_date: null }],
          },
        ],
      }),
    );

    expect(comAcao?.case.remoteReplyState).toBe("ALLOWED");
  });

  it("vincula o pedido só quando o claim é sobre uma order", () => {
    expect(mapClaimToSupportProjection(parse())?.orderId).toBe(2000007819609432);
    // `resource_id` de um claim de envio é um shipment, não um pedido —
    // vinculá-lo como order apontaria para um pedido que não existe.
    expect(mapClaimToSupportProjection(parse({ resource: "shipment" }))?.orderId).toBeNull();
  });
});

/**
 * Fixture VERBATIM do exemplo oficial de `GET /claims/{id}/messages`
 * (mesma leitura ao vivo de 2026-08-27). O vendedor da fixture é o
 * `respondent` (id 1330467461), como no exemplo do claim.
 */
const OFFICIAL_MESSAGES = [
  {
    sender_role: "respondent",
    receiver_role: "mediator",
    message: "Reclamo + mediacion +devo fallida",
    translated_message: null,
    date_created: "2023-07-17T12:52:54.000-04:00",
    last_updated: "2023-07-17T12:52:54.000-04:00",
    message_date: "2023-07-17T12:52:54.000-04:00",
    date_read: null,
    attachments: [
      {
        filename: "3cf94d52-0248-4bb4-98cc-b76c01ff5dc0.jpeg",
        original_filename: "ZAPATO.jpg",
        size: 17950,
        date_created: "2023-07-17T12:52:52.000-04:00",
        type: "image/jpeg",
      },
    ],
    status: "available",
    stage: "dispute",
    message_moderation: { status: "clean", reason: null, source: "online", date_moderated: null },
    repeated: false,
  },
  {
    sender_role: "complainant",
    receiver_role: "respondent",
    message: "Reclamo + mediacion +devo fallida",
    translated_message: null,
    date_created: "2023-07-17T12:44:05.000-04:00",
    last_updated: "2023-07-17T12:44:05.000-04:00",
    message_date: "2023-07-17T12:44:05.000-04:00",
    date_read: "2023-07-17T16:48:53Z",
    attachments: [],
    status: "available",
    stage: "claim",
    // `reason: ""` (string vazia) aqui e `null` acima — os dois no MESMO
    // exemplo oficial, motivo de o campo ser permissivo.
    message_moderation: { status: "clean", reason: "", source: "online", date_moderated: "2023-07-17T16:44:05Z" },
    repeated: false,
  },
];

function mapMessages(messages: unknown[] = OFFICIAL_MESSAGES, claimOverrides: Record<string, unknown> = {}) {
  return mapClaimMessagesToProjection(parse(claimOverrides), claimMessagesSchema.parse(messages));
}

describe("claimMessagesSchema — payload oficial", () => {
  it("aceita o array NU do exemplo oficial (sem envelope results/paging)", () => {
    const parsed = claimMessagesSchema.parse(OFFICIAL_MESSAGES);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.attachments?.[0]?.filename).toBe("3cf94d52-0248-4bb4-98cc-b76c01ff5dc0.jpeg");
  });

  it("aceita `reason` como string vazia E como null, no mesmo payload", () => {
    const parsed = claimMessagesSchema.parse(OFFICIAL_MESSAGES);

    expect(parsed[0]?.message_moderation?.reason).toBeNull();
    expect(parsed[1]?.message_moderation?.reason).toBe("");
  });
});

describe("mapClaimMessagesToProjection", () => {
  it("a chave é fingerprint, NUNCA índice do array", () => {
    // Índice quebraria: a doc filtra em silêncio mensagens moderadas da
    // contraparte, deslocando todos os índices seguintes numa re-ingestão.
    const chaves = mapMessages().map((message) => message.externalMessageKey);

    expect(chaves).toEqual([
      "claim-msg:respondent:2023-07-17T12:52:54.000-04:00",
      "claim-msg:complainant:2023-07-17T12:44:05.000-04:00",
    ]);
  });

  it("a chave NÃO leva o texto — moderar não pode duplicar a mensagem", () => {
    const antes = mapMessages()[0]?.externalMessageKey;
    const depois = mapMessages([
      { ...OFFICIAL_MESSAGES[0], message: "", status: "moderated" },
      OFFICIAL_MESSAGES[1],
    ])[0]?.externalMessageKey;

    expect(depois).toBe(antes);
  });

  it("direção sai do NOSSO papel no claim, não de quem reclama", () => {
    const [nossa, deles] = mapMessages();

    // O vendedor da fixture é `respondent`.
    expect(nossa?.direction).toBe("OUTBOUND");
    expect(nossa?.senderKind).toBe("SELLER");
    expect(deles?.direction).toBe("INBOUND");
    expect(deles?.senderKind).toBe("CUSTOMER");
  });

  it("papéis invertidos (cancel_sale): o vendedor é quem reclama", () => {
    const [primeira] = mapMessages(OFFICIAL_MESSAGES, {
      players: [
        { role: "complainant", type: "seller", user_id: 1330467461, available_actions: [] },
        { role: "respondent", type: "buyer", user_id: 1325224382, available_actions: [] },
      ],
    });

    // Agora `respondent` é o COMPRADOR — a mesma mensagem vira INBOUND.
    expect(primeira?.direction).toBe("INBOUND");
    expect(primeira?.senderKind).toBe("CUSTOMER");
  });

  it("mediador vira SYSTEM/MEDIATOR", () => {
    const [mediada] = mapMessages([{ ...OFFICIAL_MESSAGES[0], sender_role: "mediator" }]);

    expect(mediada?.direction).toBe("SYSTEM");
    expect(mediada?.senderKind).toBe("MEDIATOR");
  });

  it("sem saber nosso papel, erra para INBOUND — o erro seguro", () => {
    // Errar para OUTBOUND diria "já respondemos" e poderia suprimir atenção
    // de um atendimento em aberto. INBOUND no máximo pede atenção a mais.
    const [primeira] = mapMessages(OFFICIAL_MESSAGES, { players: null });

    expect(primeira?.direction).toBe("INBOUND");
    expect(primeira?.senderKind).toBe("UNKNOWN");
  });

  it("mensagem moderada preserva que existiu, com estado explícito", () => {
    const [moderada] = mapMessages([{ ...OFFICIAL_MESSAGES[0], status: "moderated" }]);

    expect(moderada?.bodyState).toBe("MODERATED");
    expect(moderada?.remoteStatus).toBe("moderated");
  });

  it("`message_moderation.status = rejected` também conta como moderada", () => {
    const [rejeitada] = mapMessages([
      {
        ...OFFICIAL_MESSAGES[0],
        message_moderation: { status: "rejected", reason: "OUT_OF_PLACE_LANGUAGE", source: "online" },
      },
    ]);

    expect(rejeitada?.bodyState).toBe("MODERATED");
  });

  it("mensagem vazia é EMPTY, nunca bolha em branco silenciosa", () => {
    const [vazia] = mapMessages([{ ...OFFICIAL_MESSAGES[0], message: "   " }]);

    expect(vazia?.bodyState).toBe("EMPTY");
    expect(vazia?.body).toBeNull();
  });

  it("mensagem sem instante de envio é descartada, nunca inventada", () => {
    const resultado = mapMessages([{ ...OFFICIAL_MESSAGES[0], message_date: null, date_created: null }]);

    expect(resultado).toHaveLength(0);
  });

  it("cai para date_created quando message_date falta", () => {
    const [primeira] = mapMessages([{ ...OFFICIAL_MESSAGES[0], message_date: null }]);

    expect(primeira?.occurredAt).toBe("2023-07-17T12:52:54.000-04:00");
  });

  it("transcript vazio não quebra", () => {
    expect(mapMessages([])).toEqual([]);
  });
});
