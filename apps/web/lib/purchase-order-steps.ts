/**
 * As etapas de um pedido de compra — o segundo consumidor do `.process-steps`
 * do frame (D-277, fatia D37).
 *
 * ---------------------------------------------------------------------------
 * AQUI O CICLO É EXPLÍCITO, E O BANCO GARANTE QUE ELE NÃO MENTE
 * ---------------------------------------------------------------------------
 *
 * Diferente da NF-e — onde três passos do frame eram um estado só —, o pedido
 * de compra tem quatro estados nomeados no `CHECK` e **um carimbo por
 * transição**: `approved_at`, `ordered_at`, `received_at`, `cancelled_at`. E as
 * quatro `CHECK` de coerência de `20260822234353_create_purchasing.sql`
 * impedem estado sem data:
 *
 *   status in (APPROVED, ORDERED, RECEIVED) -> approved_at is not null
 *   status in (ORDERED, RECEIVED)           -> ordered_at  is not null
 *   status = RECEIVED                       -> received_at is not null
 *   status = CANCELLED                      -> cancelled_at is not null
 *
 * Por isso cada etapa concluída pode mostrar **quando** aconteceu sem que a
 * tela precise adivinhar: a data ou existe, ou o banco teria recusado a linha.
 *
 * ---------------------------------------------------------------------------
 * `CANCELLED` NÃO É UMA QUINTA ETAPA
 * ---------------------------------------------------------------------------
 *
 * Cancelar não avança o processo, interrompe. Uma quinta bolinha "Cancelado"
 * no fim sugeriria que o pedido percorreu as quatro anteriores — e ele pode ter
 * sido cancelado ainda em rascunho. O cancelamento marca **a etapa onde
 * parou**, que é o que `purchase_orders` sabe dizer pelas datas presentes.
 *
 * "Recebimento parcial" está registrado como V3.1 (`docs/ROADMAP.md`): hoje
 * `RECEIVED` é tudo ou nada, então a quarta etapa não tem fração como a
 * conferência da NF-e tem.
 */
import type { EtapaProcesso } from "../components/process-steps";
import { formatDateTime } from "./format";

export function purchaseOrderEtapas(input: {
  status: string;
  approvedAt: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
}): readonly EtapaProcesso[] {
  const { status } = input;

  const carimbo = (valor: string | null): { nota?: string } =>
    valor === null ? {} : { nota: formatDateTime(valor) };

  const aprovou = input.approvedAt !== null;
  const pediu = input.orderedAt !== null;
  const recebeu = input.receivedAt !== null;

  // A primeira etapa é o próprio ato de existir: o rascunho foi criado.
  const etapas: readonly EtapaProcesso[] = [
    { label: "Rascunho", estado: "concluida" },
    {
      label: "Aprovado",
      ...(aprovou ? { estado: "concluida" as const } : { estado: status === "DRAFT" ? ("atual" as const) : ("pendente" as const) }),
      ...carimbo(input.approvedAt),
    },
    {
      label: "Pedido enviado",
      ...(pediu
        ? { estado: "concluida" as const }
        : { estado: status === "APPROVED" ? ("atual" as const) : ("pendente" as const) }),
      ...carimbo(input.orderedAt),
    },
    {
      label: "Recebido",
      ...(recebeu
        ? { estado: "concluida" as const }
        : { estado: status === "ORDERED" ? ("atual" as const) : ("pendente" as const) }),
      ...carimbo(input.receivedAt),
    },
  ];

  if (status !== "CANCELLED") return etapas;

  // Cancelado marca ONDE parou — a primeira etapa que não chegou ao fim. Uma
  // quinta bolinha no fim afirmaria que o pedido percorreu as quatro.
  const parou = etapas.findIndex((etapa) => etapa.estado !== "concluida");

  if (parou < 0) return etapas;

  return etapas.map((etapa, indice) =>
    indice === parou
      ? { label: etapa.label, estado: "cancelada" as const, ...carimbo(input.cancelledAt) }
      : etapa,
  );
}
