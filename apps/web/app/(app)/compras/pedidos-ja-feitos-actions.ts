"use server";

import type { Json } from "@sb/db";
import { revalidatePath } from "next/cache";

import { currentMembership } from "../../../lib/membership";
import { createClient } from "../../../lib/supabase/server";

/**
 * "Já fiz o pedido" e a importação de pedidos anteriores (D-760 a D-764).
 *
 * Toda regra mora no banco: as RPCs `security definer` refazem a autorização
 * (ADMIN/GESTOR), validam o escopo de cada parâmetro e decidem duplicidade.
 * Aqui só se traduz o erro para o português e se omite o parâmetro nulo —
 * o gerador de tipos não marca argumento de RPC como anulável (a mesma regra
 * de `actions.ts`).
 */

export interface ResultadoAcao {
  ok: boolean;
  message: string | null;
}

export interface CandidatoDuplicidade {
  motivo: "MESMA_REFERENCIA" | "MESMO_SKU_EM_ABERTO";
  purchaseOrderId: string;
  orderNumber: number;
  status: string;
  origin: string;
  externalReference: string | null;
  supplierName: string | null;
  sku: string | null;
  pendente: number | null;
}

export interface ResultadoRegistro extends ResultadoAcao {
  resultado?: "CRIADO" | "JA_REGISTRADO" | "POSSIVEL_DUPLICIDADE" | "REFERENCIA_EXISTENTE" | "NADA_A_REGISTRAR" | "ACRESCENTADO";
  pedido?: { id: string; orderNumber: number; status: string } | null;
  candidatos?: CandidatoDuplicidade[];
}

function omitir<T extends string, V>(chave: T, valor: V | null | undefined): Record<T, V> | Record<string, never> {
  return valor === null || valor === undefined || valor === "" ? {} : ({ [chave]: valor } as Record<T, V>);
}

function traduzir(error: { message: string } | null): string | null {
  if (error === null) return null;

  const m = error.message;

  if (m.includes("sem permissao")) return "Só ADMIN e GESTOR registram pedidos de compra.";
  if (m.includes("SKU nao encontrado")) return "Esse SKU não foi encontrado nesta organização.";
  if (m.includes("aparece duas vezes") || m.includes("mais de uma linha")) {
    return "O mesmo SKU aparece mais de uma vez no pedido: some as quantidades numa linha só ou ignore uma delas.";
  }
  if (m.includes("quantidade positiva") || m.includes("quantidade precisa")) return "Informe uma quantidade maior que zero.";
  if (m.includes("data do pedido nao pode estar no futuro")) return "A data do pedido não pode estar no futuro.";
  if (m.includes("ja tem a referencia")) return "Este pedido já tem outra referência. Corrija pela tela do pedido.";
  if (m.includes("ja esta em outro pedido")) return "Essa referência já está em outro pedido deste fornecedor.";
  if (m.includes("pedido interno")) return "Pedido interno se edita pela tela do pedido.";
  if (m.includes("ja esta neste pedido")) return "Esse SKU já está neste pedido. Ajuste a quantidade pela tela do pedido.";
  if (m.includes("estado terminal") || m.includes("esta cancelado") || m.includes("nao aceita itens")) {
    return "Este pedido já foi recebido ou cancelado.";
  }
  if (m.includes("outra organizacao")) return "Esse fornecedor pertence a outra organização.";
  if (m.includes("confirme as quantidades")) return "Confirme as quantidades desta referência antes de registrar.";
  if (m.includes("escolha o SKU")) return "Escolha o SKU antes de vincular a linha.";
  if (m.includes("informe a referencia")) return "Informe a referência do pedido.";
  if (m.includes("ja virou pedido")) return "Essa linha já virou pedido. Corrija pela tela do pedido.";
  if (m.includes("no maximo 5000")) return "A planilha tem mais de 5.000 quantidades. Divida o arquivo e importe em partes.";
  if (m.includes("nenhuma quantidade")) return "Nenhuma quantidade encontrada para importar.";
  if (m.includes("etapa")) return "Essa etapa não vale para a situação escolhida.";
  if (m.includes("nao encontrado")) return "Registro não encontrado.";

  return "Não foi possível concluir a ação.";
}

async function organizacao(): Promise<{ supabase: Awaited<ReturnType<typeof createClient>>; org: string | null; erro: string | null }> {
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.error !== null) return { supabase, org: null, erro: "Não foi possível confirmar sua organização. Tente de novo." };
  if (membership.organizationId === null) return { supabase, org: null, erro: "Sua conta não está associada a nenhuma organização." };

  return { supabase, org: membership.organizationId, erro: null };
}

function lerRegistro(data: unknown): Omit<ResultadoRegistro, "ok" | "message"> {
  const d = (data ?? {}) as { resultado?: ResultadoRegistro["resultado"]; pedido?: ResultadoRegistro["pedido"]; candidatos?: CandidatoDuplicidade[] };

  return { resultado: d.resultado, pedido: d.pedido ?? null, candidatos: d.candidatos ?? [] } as Omit<ResultadoRegistro, "ok" | "message">;
}

function revalidar(pedidoId?: string | null): void {
  revalidatePath("/reposicao");
  revalidatePath("/compras");
  if (pedidoId !== null && pedidoId !== undefined) revalidatePath(`/compras/${pedidoId}`);
}

export interface PedidoJaFeitoInput {
  requestId: string;
  itens: { skuId: string; quantity: number }[];
  situacao: "PLANEJADO" | "PEDIDO_REALIZADO";
  fornecedorId: string | null;
  referencia: string | null;
  dataPedido: string | null;
  previsao: string | null;
  etapa: string | null;
  observacoes: string | null;
  confirmarNovo: boolean;
}

export async function registrarPedidoJaFeito(input: PedidoJaFeitoInput): Promise<ResultadoRegistro> {
  const { supabase, org, erro } = await organizacao();

  if (org === null) return { ok: false, message: erro };

  const { data, error } = await supabase.rpc("register_placed_purchase_order", {
    p_organization_id: org,
    p_request_id: input.requestId,
    p_items: input.itens satisfies Json,
    p_situacao: input.situacao,
    p_origin: "EXTERNO_MANUAL",
    ...omitir("p_supplier_id", input.fornecedorId),
    ...omitir("p_external_reference", input.referencia?.trim()),
    ...omitir("p_supplier_ordered_on", input.dataPedido),
    ...omitir("p_expected_at", input.previsao),
    ...omitir("p_stage", input.etapa),
    ...omitir("p_notes", input.observacoes?.trim()),
    ...(input.confirmarNovo ? { p_confirm_new: true } : {}),
  });

  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  const r = lerRegistro(data);

  if (r.resultado === "CRIADO") revalidar(r.pedido?.id);

  return { ok: true, message: null, ...r };
}

export async function vincularReferenciaExterna(pedidoId: string, referencia: string, dataPedido: string | null): Promise<ResultadoAcao> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("link_purchase_order_external_reference", {
    p_id: pedidoId,
    p_external_reference: referencia.trim(),
    ...omitir("p_supplier_ordered_on", dataPedido),
  });
  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  revalidar(pedidoId);

  return { ok: true, message: null };
}

export async function acrescentarAoPedidoExterno(
  pedidoId: string,
  itens: { skuId: string; quantity: number }[],
  requestId: string,
): Promise<ResultadoAcao> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_purchase_order_items_placed", {
    p_id: pedidoId,
    p_items: itens satisfies Json,
    p_request_id: requestId,
  });
  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  revalidar(pedidoId);

  return { ok: true, message: null };
}

export async function atualizarPrevisao(pedidoId: string, previsao: string | null, nota: string | null): Promise<ResultadoAcao> {
  const supabase = await createClient();
  // Previsão vazia limpa (desconhecida): o parâmetro vai explícito como nulo.
  const { error } = await supabase.rpc("set_purchase_order_expected_at", {
    p_id: pedidoId,
    p_expected_at: previsao,
    ...omitir("p_note", nota?.trim()),
  });
  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  revalidar(pedidoId);

  return { ok: true, message: null };
}

// ---------------------------------------------------------------------------
// Importação de pedidos anteriores (D-764)
// ---------------------------------------------------------------------------

export interface LinhaImportacao {
  sheet: string;
  row: number;
  column: string;
  code: string | null;
  ean: string | null;
  ncm: string | null;
  description: string | null;
  quantityRaw: string;
  quantity: number | null;
  quantityNeedsConfirmation: boolean;
  reference: string | null;
  notes: string | null;
  raw: Record<string, string>;
}

export async function criarLoteImportacao(input: {
  nomeArquivo: string;
  sha256: string;
  abas: string[];
  linhas: LinhaImportacao[];
}): Promise<ResultadoAcao & { loteId?: string; existente?: boolean }> {
  const { supabase, org, erro } = await organizacao();

  if (org === null) return { ok: false, message: erro };

  const { data, error } = await supabase.rpc("create_purchase_import_batch", {
    p_organization_id: org,
    p_file_name: input.nomeArquivo,
    p_file_sha256: input.sha256,
    p_sheet_names: input.abas,
    p_rows: input.linhas as unknown as Json,
  });
  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  const d = data as { batchId: string; existente: boolean };

  return { ok: true, message: null, loteId: d.batchId, existente: d.existente };
}

export interface CorrecaoLinha {
  rowId: string;
  skuId?: string | null;
  quantity?: number | null;
  quantityConfirmed?: boolean;
  externalReference?: string | null;
  resolution?: "PENDENTE" | "VINCULADA" | "IGNORADA";
}

export async function corrigirLinhasImportacao(loteId: string, correcoes: CorrecaoLinha[]): Promise<ResultadoAcao> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_purchase_import_rows", {
    p_batch_id: loteId,
    p_changes: correcoes as unknown as Json,
  });
  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  revalidatePath(`/compras/importar/${loteId}`);

  return { ok: true, message: null };
}

export async function registrarReferenciaImportada(input: {
  loteId: string;
  referencia: string;
  situacao: "PLANEJADO" | "PEDIDO_REALIZADO";
  fornecedorId: string | null;
  previsao: string | null;
  dataPedido: string | null;
  etapa: string | null;
  confirmarNovo: boolean;
  pedidoAlvoId: string | null;
}): Promise<ResultadoRegistro> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("commit_purchase_import_group", {
    p_batch_id: input.loteId,
    p_reference: input.referencia,
    p_situacao: input.situacao,
    ...omitir("p_supplier_id", input.fornecedorId),
    ...omitir("p_expected_at", input.previsao),
    ...omitir("p_supplier_ordered_on", input.dataPedido),
    ...omitir("p_stage", input.etapa),
    ...(input.confirmarNovo ? { p_confirm_new: true } : {}),
    ...omitir("p_target_order_id", input.pedidoAlvoId),
  });
  const message = traduzir(error);

  if (message !== null) return { ok: false, message };

  const r = lerRegistro(data);

  revalidatePath(`/compras/importar/${input.loteId}`);
  if (r.resultado === "CRIADO" || r.resultado === "ACRESCENTADO") revalidar(r.pedido?.id);

  return { ok: true, message: null, ...r };
}

/** Busca de SKU para vincular uma linha (até 20), pela mesma RLS do catálogo. */
export async function buscarSkus(termo: string): Promise<{ id: string; sku: string; title: string | null; kind: string }[]> {
  const t = termo.trim();

  if (t.length < 2) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("skus")
    .select("id, sku, title, kind")
    .or(`sku.ilike.%${t.replace(/[%,()]/g, "")}%,title.ilike.%${t.replace(/[%,()]/g, "")}%`)
    .order("sku")
    .limit(20);

  return data ?? [];
}
