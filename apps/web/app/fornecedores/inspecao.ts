"use server";

import { createClient } from "../../lib/supabase/server";

/**
 * O retrato da gaveta "Detalhe do Fornecedor" (D39, a segunda das cinco).
 *
 * **Uma ida, e nenhuma RPC nova.** `get_supplier_overview` já devolve cadastro
 * e agregados de pedidos numa linha só — é a mesma função que
 * `/fornecedores/[supplierId]` lê (D-174, corrigida em D-258). A gaveta é um
 * recorte dela, não uma segunda fonte.
 *
 * O que a lista de `/fornecedores` mostra e o que a gaveta acrescenta são
 * conjuntos diferentes de propósito: a lista tem nome, documento, contato,
 * pedidos, último pedido e valor; a gaveta traz **os canais de contato**
 * (e-mail, telefone, WhatsApp, site), a **decomposição dos pedidos por
 * estado** e a ressalva de custo ausente. Repetir a linha seria duplicar a
 * tabela dentro de uma gaveta.
 *
 * `organization_id` vem do cliente, como nas outras gavetas: a função é
 * `security invoker` sobre tabelas com RLS, então um id forjado devolve
 * VAZIO.
 */

export interface SupplierInspection {
  name: string | null;
  legalName: string | null;
  document: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  isActive: boolean | null;
  ordersTotal: number | null;
  ordersDraft: number | null;
  ordersApproved: number | null;
  ordersOrdered: number | null;
  ordersReceived: number | null;
  ordersCancelled: number | null;
  skusDistintos: number | null;
  /** NULO com itens e nenhum custo — ausência não é zero (D-254). */
  valorPedido: number | null;
  itensSemCusto: number | null;
  primeiroPedidoEm: string | null;
  ultimoPedidoEm: string | null;
  error: string | null;
}

const VAZIO: SupplierInspection = {
  name: null,
  legalName: null,
  document: null,
  contactName: null,
  email: null,
  phone: null,
  whatsapp: null,
  website: null,
  isActive: null,
  ordersTotal: null,
  ordersDraft: null,
  ordersApproved: null,
  ordersOrdered: null,
  ordersReceived: null,
  ordersCancelled: null,
  skusDistintos: null,
  valorPedido: null,
  itensSemCusto: null,
  primeiroPedidoEm: null,
  ultimoPedidoEm: null,
  error: null,
};

export async function inspecionarFornecedor(
  organizationId: string,
  supplierId: string,
): Promise<SupplierInspection> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("get_supplier_overview", { p_organization_id: organizationId, p_supplier_id: supplierId })
    .maybeSingle();

  if (error !== null) {
    return { ...VAZIO, error: "Não foi possível ler o cadastro deste fornecedor." };
  }

  if (data === null) {
    return { ...VAZIO, error: "Fornecedor não encontrado nesta organização." };
  }

  return {
    name: data.name,
    legalName: data.legal_name,
    document: data.document,
    contactName: data.contact_name,
    email: data.email,
    phone: data.phone,
    whatsapp: data.whatsapp,
    website: data.website,
    isActive: data.is_active,
    ordersTotal: data.orders_total,
    ordersDraft: data.orders_draft,
    ordersApproved: data.orders_approved,
    ordersOrdered: data.orders_ordered,
    ordersReceived: data.orders_received,
    ordersCancelled: data.orders_cancelled,
    skusDistintos: data.skus_distintos,
    valorPedido: data.valor_pedido,
    itensSemCusto: data.itens_sem_custo,
    primeiroPedidoEm: data.primeiro_pedido_em,
    ultimoPedidoEm: data.ultimo_pedido_em,
    error: null,
  };
}
