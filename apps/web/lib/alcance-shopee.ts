/**
 * O ALCANCE NAS LOJAS SHOPEE em `/usuarios` (D-434, etapa T2 da frente
 * multicanal), o espelho do alcance nas contas do Mercado Livre.
 *
 * A regra é do banco (D-433, `private.accessible_shopee_shops`): ADMIN alcança
 * todas as lojas da organização sem linha nenhuma; os demais, as concedidas em
 * `user_shopee_shop_permissions`, que só um ADMIN escreve — direto, sob a RLS,
 * como `user_account_permissions`. Aqui mora só o que a tela precisa dizer.
 */

import { lojaDeTesteShopee, nomeDaLojaShopee } from "./shopee-sales";

/**
 * O nome da loja como opção de alcance, com "(teste)" na de sandbox — a mesma
 * marca das telas da Shopee. Conceder a loja de teste é possível e às vezes
 * útil (ensaiar a operação), mas ninguém pode confundi-la com a loja real.
 */
export function rotuloDaLojaNoAlcance(loja: {
  readonly shop_name: string | null;
  readonly shop_id: number;
  readonly environment: string;
}): string {
  const nome = nomeDaLojaShopee(loja);

  return lojaDeTesteShopee(loja.environment) ? `${nome} (teste)` : nome;
}

/**
 * As lojas pedidas no convite que o banco NÃO mostra concedidas depois dele.
 *
 * A api no ar mais velha que a tela não conhece `shopeeShopIds` e o descarta
 * em silêncio (o validador ignora campo desconhecido): o convite valeria, e a
 * pessoa entraria sem as lojas que a tela disse ter dado. Conferir no banco é
 * o que impede essa promessa — a frase diz o que faltou, e a gaveta resolve.
 */
export function lojasNaoConcedidas(pedidas: readonly string[], concedidas: readonly string[]): string[] {
  const dadas = new Set(concedidas);

  return pedidas.filter((id) => !dadas.has(id));
}
