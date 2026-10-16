"use server";

import { revalidatePath } from "next/cache";

import {
  describeShopeeLinkError,
  lerRemocaoShopee,
  lerVinculoShopee,
  type EntradaDoVinculoShopee,
  type ResultadoDoVinculoShopee,
} from "../../../../lib/shopee-link";
import { createClient } from "../../../../lib/supabase/server";

/**
 * O vínculo manual do anúncio Shopee (D-429), na forma das ações de
 * `/vinculacoes` (D-012): escrita simples no escopo do usuário, sem segredo e
 * sem trabalho longo. Só chama a RPC — autorização (ADMIN, GESTOR, OPERADOR na
 * organização da loja), SKU da mesma organização, unidade no catálogo
 * sincronizado e o histórico vivem dentro dela, na mesma transação.
 *
 * A web nunca chama a Shopee: o vínculo é uma relação DENTRO desta casa, e o
 * anúncio na Shopee fica como está.
 *
 * `revalidatePath` refaz a tela na mesma resposta: quando a ação volta, a
 * linha já mostra o estado novo — e a faixa, que conta "Vinculados" no SQL,
 * já contou o manual. A página do SKU lê o mesmo vínculo (painel "Anúncios da
 * Shopee").
 */

function revalidar(): void {
  revalidatePath("/anuncios/shopee");
  revalidatePath("/skus/[skuId]", "page");
}

/** Cria o vínculo manual de uma unidade, ou troca o SKU do que já existe. */
export async function vincularAnuncioShopee(entrada: EntradaDoVinculoShopee): Promise<ResultadoDoVinculoShopee> {
  const lida = lerVinculoShopee(entrada);

  if (!lida.ok) return { ok: false, message: lida.message };

  const { lojaId, itemId, modelId, skuId, motivo } = lida.value;
  const supabase = await createClient();

  const { error } = await supabase.rpc("set_shopee_sku_link", {
    p_shopee_shop_id: lojaId,
    p_item_id: itemId,
    p_model_id: modelId,
    p_sku_id: skuId,
    p_reason: motivo,
  });

  const message = describeShopeeLinkError(error);

  if (message !== null) return { ok: false, message };

  revalidar();

  return { ok: true, message: null };
}

/** Remove o vínculo manual, com motivo; o SKU do anúncio volta a valer. */
export async function removerVinculoShopee(linkId: string, motivo: string): Promise<ResultadoDoVinculoShopee> {
  const lida = lerRemocaoShopee(linkId, motivo);

  if (!lida.ok) return { ok: false, message: lida.message };

  const supabase = await createClient();

  const { error } = await supabase.rpc("remove_shopee_sku_link", {
    p_link_id: lida.value.linkId,
    p_reason: lida.value.motivo,
  });

  const message = describeShopeeLinkError(error);

  if (message !== null) return { ok: false, message };

  revalidar();

  return { ok: true, message: null };
}
