import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Caller } from "./auth.js";

/**
 * Editar os itens lidos de um documento enviado (D-766), antes da confirmação.
 *
 * O documento lido nem sempre é o que sai ou entra: o envio ao Full traz 12
 * unidades e saem 10; a nota traz um item que não veio. Até aqui a conferência
 * só deixava trocar o SKU; agora dá para mudar a QUANTIDADE e REMOVER o item.
 *
 * Só em `PARSED` (conferência): depois da confirmação o documento é história.
 * Escrita com a chave de serviço, pela `api` e não por RPC, porque criar a RPC
 * pediria migration (`infra/vm/README.md`); a organização e o papel são
 * conferidos aqui. Ao fim, `total_items` e `resolved_items` são recontados dos
 * itens — a confirmação e a aplicação leem os dois.
 */

export const QUANTIDADE_MAX = 1_000_000_000;

const tresCasas = (valor: number): boolean => Math.abs(Math.round(valor * 1000) - valor * 1000) < 1e-6;

export const comandoDeItemSchema = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("quantidade"),
    // `document_items.quantity` é numeric(14,3) e > 0: a NF-e tem unidade
    // fracionada (metro, quilo), então inteiro só seria pouco.
    quantidade: z.number().positive().max(QUANTIDADE_MAX).refine(tresCasas, "no máximo três casas decimais"),
  }),
  z.object({ acao: z.literal("remover") }),
]);

export type ComandoDeItem = z.infer<typeof comandoDeItemSchema>;

export interface DocumentItemsDeps {
  db: AdminClient;
  logger: Logger;
}

export type EditDocumentItemOutcome =
  | { status: "updated"; totalItems: number; resolvedItems: number }
  | { status: "not_found" }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

/** O valor total acompanha a quantidade; sem preço no documento, continua sem (D-254). */
export function valorTotalDoItem(valorUnitario: number | null, quantidade: number): number | null {
  if (valorUnitario === null) return null;

  return Math.round(valorUnitario * quantidade * 100) / 100;
}

export async function editDocumentItem(
  deps: DocumentItemsDeps,
  caller: Caller,
  documentId: string,
  itemId: number,
  comando: ComandoDeItem,
): Promise<EditDocumentItemOutcome> {
  const documento = await deps.db
    .from("documents")
    .select("id, status")
    .eq("id", documentId)
    .eq("organization_id", caller.organizationId)
    .maybeSingle();

  if (documento.error !== null) {
    return { status: "failed", reason: "não foi possível consultar o documento" };
  }

  if (documento.data === null) {
    return { status: "not_found" };
  }

  if (documento.data.status !== "PARSED") {
    return { status: "rejected", reason: "só documentos em conferência aceitam alteração" };
  }

  const item = await deps.db
    .from("document_items")
    .select("id, quantity, unit_value")
    .eq("id", itemId)
    .eq("document_id", documentId)
    .maybeSingle();

  if (item.error !== null) {
    return { status: "failed", reason: "não foi possível consultar o item" };
  }

  if (item.data === null) {
    return { status: "not_found" };
  }

  if (comando.acao === "remover") {
    const quantos = await deps.db
      .from("document_items")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId);

    if (quantos.error !== null) {
      return { status: "failed", reason: "não foi possível contar os itens do documento" };
    }

    // Um documento sem item nenhum não tem o que confirmar; para não aplicar
    // nada, basta deixá-lo em conferência.
    if ((quantos.count ?? 0) <= 1) {
      return { status: "rejected", reason: "o documento precisa de ao menos um item" };
    }

    const removido = await deps.db
      .from("document_items")
      .delete()
      .eq("id", itemId)
      .eq("document_id", documentId)
      .select("id")
      .maybeSingle();

    if (removido.error !== null) {
      return { status: "failed", reason: "não foi possível remover o item" };
    }

    if (removido.data === null) {
      return { status: "not_found" };
    }
  } else {
    const alterado = await deps.db
      .from("document_items")
      .update({
        quantity: comando.quantidade,
        total_value: valorTotalDoItem(item.data.unit_value, comando.quantidade),
      })
      .eq("id", itemId)
      .eq("document_id", documentId)
      .select("id")
      .maybeSingle();

    if (alterado.error !== null) {
      return { status: "failed", reason: "não foi possível alterar a quantidade" };
    }

    if (alterado.data === null) {
      return { status: "not_found" };
    }
  }

  const contagem = await recontar(deps.db, documentId);

  if (contagem.status === "failed") {
    return { status: "failed", reason: "o item mudou, mas a contagem do documento não foi refeita — recarregue" };
  }

  if (contagem.status === "left_parsed") {
    return { status: "rejected", reason: "o documento saiu de conferência durante a edição — recarregue" };
  }

  deps.logger.info("document_item_edited", {
    document_id: documentId,
    item_id: itemId,
    acao: comando.acao,
    quantidade_antes: item.data.quantity,
    ...(comando.acao === "quantidade" ? { quantidade_depois: comando.quantidade } : {}),
    by: caller.userId,
  });

  return { status: "updated", totalItems: contagem.totalItems, resolvedItems: contagem.resolvedItems };
}

async function recontar(
  db: AdminClient,
  documentId: string,
): Promise<
  | { status: "ok"; totalItems: number; resolvedItems: number }
  | { status: "left_parsed" }
  | { status: "failed" }
> {
  const [total, vinculados] = await Promise.all([
    db.from("document_items").select("id", { count: "exact", head: true }).eq("document_id", documentId),
    db
      .from("document_items")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .not("sku_id", "is", null),
  ]);

  if (total.error !== null || vinculados.error !== null) return { status: "failed" };

  const totalItems = total.count ?? 0;
  const resolvedItems = vinculados.count ?? 0;

  // Só enquanto o documento segue em conferência: se a confirmação chegou no
  // meio, a contagem que ela leu é a que vale (D-770: devolve rejected).
  const gravado = await db
    .from("documents")
    .update({ total_items: totalItems, resolved_items: resolvedItems })
    .eq("id", documentId)
    .eq("status", "PARSED")
    .select("id")
    .maybeSingle();

  if (gravado.error !== null) return { status: "failed" };

  if (gravado.data === null) return { status: "left_parsed" };

  return { status: "ok", totalItems, resolvedItems };
}
