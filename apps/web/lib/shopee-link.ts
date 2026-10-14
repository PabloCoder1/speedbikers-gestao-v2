/**
 * O VÍNCULO MANUAL do anúncio Shopee com o SKU (D-429, fatia 4b da trilha
 * Shopee) — o vocabulário que a tela e as Server Actions dividem.
 *
 * Quem decide é o banco: `set_shopee_sku_link` e `remove_shopee_sku_link`
 * conferem o papel, a organização do SKU e se a unidade está no catálogo
 * sincronizado. Aqui mora só o que a tela precisa ANTES de chamar (quem vê os
 * botões, que botão cada linha tem, a forma da entrada) e a tradução das
 * recusas — cada fragmento corresponde a um `raise exception` nomeado da
 * migration `20261014120000_vinculo_manual_shopee.sql`, nunca ao texto cru do
 * Postgres.
 */

/**
 * O mesmo corte das duas RPCs (`private.has_org_role(..., ADMIN, GESTOR,
 * OPERADOR)`). A tela esconde os botões de quem não pode; quem garante é o
 * banco — um clique que escapasse daria "sem permissão" do mesmo jeito.
 */
const PAPEIS_QUE_VINCULAM = new Set(["ADMIN", "GESTOR", "OPERADOR"]);

export function podeVincularShopee(role: string | null): boolean {
  return role !== null && PAPEIS_QUE_VINCULAM.has(role);
}

/** O motivo vai para `shopee_sku_link_events.reason`, que aceita de 1 a 500 caracteres. */
export const MOTIVO_MAX = 500;

/**
 * O que a coluna "Vínculo" oferece em cada linha:
 *
 * - `manual`: o vínculo manual existe — trocar o SKU ou remover (com motivo);
 * - `outro-sku`: vinculado pelo SKU do anúncio — vincular a outro SKU (o
 *   manual vence);
 * - `vincular`: sem SKU no anúncio, ou SKU fora do catálogo;
 * - `aguardando`: o catálogo ainda não leu a unidade, e a RPC recusaria — a
 *   linha não tem botão, e a tela diz por quê;
 * - `nenhuma`: estado que a tela não conhece; nada é oferecido às cegas.
 */
export type AcaoDoVinculoShopee =
  | { readonly tipo: "manual"; readonly linkId: string }
  | { readonly tipo: "outro-sku" }
  | { readonly tipo: "vincular" }
  | { readonly tipo: "aguardando" }
  | { readonly tipo: "nenhuma" };

export function acaoDoVinculoShopee(linha: {
  readonly estado: string;
  readonly vinculo_via: string | null;
  readonly manual_link_id: string | null;
}): AcaoDoVinculoShopee {
  if (linha.estado === "VINCULADO") {
    if (linha.vinculo_via === "MANUAL") {
      // Manual sem o id não tem o que trocar nem remover: a RPC recusaria.
      return linha.manual_link_id === null ? { tipo: "nenhuma" } : { tipo: "manual", linkId: linha.manual_link_id };
    }

    return linha.vinculo_via === "SKU_DO_ANUNCIO" ? { tipo: "outro-sku" } : { tipo: "nenhuma" };
  }

  if (linha.estado === "SEM_SKU_NO_ANUNCIO" || linha.estado === "SKU_FORA_DO_CATALOGO") return { tipo: "vincular" };

  if (linha.estado === "AGUARDANDO_LEITURA") return { tipo: "aguardando" };

  return { tipo: "nenhuma" };
}

/**
 * O SKU que o anúncio indica, só quando ele DISCORDA do vínculo manual — é a
 * única hora em que dizê-lo ajuda ("o anúncio indica X").
 */
export function skuQueOAnuncioIndica(linha: {
  readonly vinculo_via: string | null;
  readonly sku: string | null;
  readonly sku_pelo_anuncio: string | null;
}): string | null {
  if (linha.vinculo_via !== "MANUAL" || linha.sku_pelo_anuncio === null) return null;

  return linha.sku_pelo_anuncio === linha.sku ? null : linha.sku_pelo_anuncio;
}

/**
 * O que acontece com a linha depois de remover o vínculo manual: o SKU do
 * anúncio volta a valer — e ele pode levar a um SKU, ou a lugar nenhum.
 */
export function depoisDaRemocao(linha: { readonly skuAnuncio: string | null; readonly skuPeloAnuncio: string | null }): string {
  if (linha.skuPeloAnuncio !== null) {
    return `Depois da remoção vale o SKU do anúncio: a linha passa a ficar vinculada ao SKU ${linha.skuPeloAnuncio}.`;
  }

  if (linha.skuAnuncio !== null) {
    return `Depois da remoção vale o SKU do anúncio, “${linha.skuAnuncio}”, que não existe no catálogo: a linha fica sem vínculo.`;
  }

  return "O anúncio não tem SKU do vendedor: depois da remoção a linha fica sem vínculo.";
}

/* ------------------------------------------------------------------------ */
/* A entrada das Server Actions                                              */
/* ------------------------------------------------------------------------ */

/**
 * Uma Server Action é um endpoint público: o argumento chega do navegador e
 * pode ter qualquer forma. A conferência aqui é de FORMA (id, número, texto);
 * autorização e existência são do banco.
 */
export interface EntradaDoVinculoShopee {
  readonly lojaId: string;
  readonly itemId: number;
  /** Nulo = o item sem variação. */
  readonly modelId: number | null;
  readonly skuId: string;
  readonly motivo?: string;
}

export interface ResultadoDoVinculoShopee {
  readonly ok: boolean;
  readonly message: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ehUuid(valor: unknown): valor is string {
  return typeof valor === "string" && UUID.test(valor);
}

/** `item_id` e `model_id` são `bigint > 0` no banco; acima de 2^53 o número já chegou errado. */
function ehIdShopee(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0;
}

type Lido<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Texto aparado; vazio é ausente. */
function aparar(valor: unknown): string | null {
  if (typeof valor !== "string") return null;

  const limpo = valor.trim();

  return limpo === "" ? null : limpo;
}

export function lerVinculoShopee(
  entrada: unknown,
): Lido<{ lojaId: string; itemId: number; modelId: number | null; skuId: string; motivo: string | null }> {
  if (typeof entrada !== "object" || entrada === null) {
    return { ok: false, message: "Pedido de vínculo incompleto. Recarregue a página." };
  }

  const { lojaId, itemId, modelId, skuId, motivo } = entrada as Record<string, unknown>;

  if (!ehUuid(lojaId) || !ehIdShopee(itemId) || !(modelId === null || ehIdShopee(modelId))) {
    return { ok: false, message: "Anúncio inválido. Recarregue a página." };
  }

  if (!ehUuid(skuId)) {
    return { ok: false, message: "Escolha o SKU de destino." };
  }

  const texto = aparar(motivo);

  if (texto !== null && texto.length > MOTIVO_MAX) {
    return { ok: false, message: `O motivo passa de ${String(MOTIVO_MAX)} caracteres.` };
  }

  return { ok: true, value: { lojaId, itemId, modelId, skuId, motivo: texto } };
}

export function lerRemocaoShopee(linkId: unknown, motivo: unknown): Lido<{ linkId: string; motivo: string }> {
  if (!ehUuid(linkId)) {
    return { ok: false, message: "Vínculo inválido. Recarregue a página." };
  }

  const texto = aparar(motivo);

  if (texto === null) {
    return { ok: false, message: "Informe o motivo da remoção — ele fica no histórico." };
  }

  if (texto.length > MOTIVO_MAX) {
    return { ok: false, message: `O motivo passa de ${String(MOTIVO_MAX)} caracteres.` };
  }

  return { ok: true, value: { linkId, motivo: texto } };
}

/**
 * As recusas das RPCs em português claro. A ordem importa: os textos
 * específicos de "não encontrado" vêm antes do genérico.
 */
export function describeShopeeLinkError(error: { message: string; code?: string } | null): string | null {
  if (error === null) return null;

  const texto = error.message;

  if (error.code === "PGRST202" || error.code === "42883") {
    return "O vínculo manual da Shopee chega com a próxima atualização do banco.";
  }

  if (texto.includes("sem permissao")) {
    return "Você não tem permissão para vincular anúncios desta loja — vincular à mão é para administrador, gestor ou operador.";
  }

  if (texto.includes("outra organizacao")) {
    return "Esse SKU pertence a outra organização.";
  }

  if (texto.includes("variacao nao encontrada no catalogo")) {
    return "Esta variação não está no catálogo lido da Shopee — ela pode ter sido apagada. Recarregue a página; o catálogo é relido de hora em hora.";
  }

  if (texto.includes("item sem variacao nao encontrado no catalogo")) {
    return "Este anúncio ainda não foi lido por inteiro, ou saiu do catálogo da Shopee. Recarregue a página; o catálogo é relido de hora em hora.";
  }

  if (texto.includes("vincule cada variacao")) {
    return "Este anúncio tem variações: o vínculo é por variação. Recarregue a página para ver cada uma.";
  }

  if (texto.includes("loja shopee") && texto.includes("nao encontrada")) {
    return "A loja deste anúncio não foi encontrada. Recarregue a página.";
  }

  if (texto.includes("motivo obrigatorio")) {
    return "Informe o motivo da remoção — ele fica no histórico.";
  }

  if (texto.includes("nao encontrado")) {
    return "Este vínculo manual não existe mais — outra pessoa pode tê-lo removido. Recarregue a página.";
  }

  if (error.code === "23505") {
    return "Outra pessoa vinculou este anúncio agora mesmo. Recarregue a página.";
  }

  return "Não foi possível gravar agora. Tente de novo.";
}
