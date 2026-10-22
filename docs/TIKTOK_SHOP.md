# TikTok Shop Open API — integração

Terceiro canal da V3, **só leitura** como a Shopee (D-601). Este documento
guarda o contrato **conferido** na documentação oficial e o estado da
integração. Narrativa e porquê moram em `docs/DECISIONS.md` (D-601 em diante).

**Estado (22/10/2026): a fatia 1, a conexão da loja, está em código (D-645)** e
ainda não está ligada em produção. As rotas, as tabelas e o cliente estão
descritos na §15. O contrato abaixo foi lido na documentação oficial antes do código.

**Como a documentação foi lida.** O Partner Center é renderizado por
JavaScript; o conteúdo de cada página `https://partner.tiktokshop.com/docv2/page/<slug>`
vem da API de documentos que a própria página consome
(`https://partner.tiktokshop.com/api/v1/document/detail?document_id=<slug>&workspace_id=3&aid=359713&locale=en-US`).
Abaixo, **P** = `https://partner.tiktokshop.com/docv2/page/`. Lido em 20/10/2026.

**Os dois graus de conferência:**
- **CONFERIDO** — lido na página oficial nesta sessão: assinatura, autorização, pedidos (busca, campos e status), webhooks (assinatura, prazo e retentativas), loja de teste no Brasil e os campos do Brasil no pedido.
- **DA DOC** — levantado na documentação oficial com a página citada, sem segunda leitura. Antes de codificar a fatia que usa o dado, relê-se a página citada.

O que a documentação **não** confirma está na §14, e não se implementa por suposição.

## 1. O app

| | |
|---|---|
| Partner Center | `https://partner.tiktokshop.com`: o global, que serve o Brasil. `partner.us.tiktokshop.com` é só dos EUA (DA DOC, P`developer-onboarding`) |
| Criado | Pelo dono em 16/10/2026, com os endereços reservados: Redirect URL `https://api-p6gzq3hzca-rj.a.run.app/oauth/tiktok-shop/callback`, Webhook URL `https://api-p6gzq3hzca-rj.a.run.app/push/tiktok-shop` e o IP de saída `34.95.145.35` (D-457). A rota da Redirect URL existe desde a D-645; a do webhook, ainda não |
| `service_id` | `7697150457891358480` (passado pelo dono em 22/10). Não é segredo: vai no link de autorização |
| Segredos | App Key e App Secret ficam só no Secret Manager, criados pelo dono. Nunca em chat, print, `.env` versionado ou Git |

**Tipos de desenvolvedor e de app (DA DOC; P`tts-developer-types`, P`seller-developer-onboarding-onepager`, P`create-your-app`, P`publish-custom-app`):**
- **Seller developer:** o vendedor que integra a própria loja. Usa um **custom app** privado, vinculado a uma loja só, a dele. É o caso da Speed Bikers.
- **ISV:** publica um **public app** na App & Service Store. Quem já tem conta de vendedor não pode virar ISV, e a categoria do app é irreversível.
- **Pré-requisitos do seller developer:** a loja com KYB/KYC concluído e um Account Manager atribuído; a entrada com a conta *owner* (subconta não pode); e o mesmo e-mail da loja.

**Para o app ficar ativo (DA DOC, P`app-development-overview`, P`app-review-process`, P`publish-custom-app`):**
- **Revisão:** o custom app passa pela revisão de cadastro e, quando se aplica, pela de compliance. O **Publish** gera o link de autorização.
- **Antes do Publish**, só lojas de teste autorizam o app.
- **App review:** é exigida na categoria Connector ou acima de 25 autorizações. O app da própria loja normalmente não passa por ela (ver §14, item 12).

**Escopos (DA DOC, P`access-scope`, P`common-errors`):**
- Há escopos públicos, liberados por padrão, e custom, que se pedem em *App & Service > Manage > Manage API*. O token devolve `granted_scopes`, e a falta de escopo dá o erro `105005`.
- Para a leitura: Shop Authorized Information, Order Information, Finance Information, Product Basic, Return & Refund Basic e Logistics Basic.

## 2. Endereços — CONFERIDO

Fontes: P`authorization-overview-202407`, P`methods-and-endpoints`.

| | Endereço |
|---|---|
| Open API (todos os mercados) | `https://open-api.tiktokglobalshop.com` |
| Autorização da loja, fora dos EUA | `https://services.tiktokshop.com/open/authorize` |
| Token (todos os mercados) | `https://auth.tiktok-shops.com/api/v2/token/get` e `.../token/refresh` |

A documentação divide só em "EUA × resto do mundo" e não cita o Brasil nessa tabela. O Brasil está no "resto do mundo" pela lista de regiões (P`regions-and-languages`: Brazil, BR, pt-BR).

## 3. Assinatura — CONFERIDO

Fonte: P`sign-your-api-request`, com o código oficial em Go, Java, Node.js e Python. O levantamento recalculou o exemplo oficial, e ele bate.

1. **Os parâmetros:** todos os parâmetros de query, **menos** `sign` e `access_token`. O `shop_cipher` entra.
2. **A ordem:** as chaves em ordem alfabética.
3. **A concatenação:** `{chave}{valor}`, sem separador.
4. **O caminho na frente:** o path exatamente como vai depois do host, com a versão (`/order/202309/orders/search`).
5. **O corpo:** se o `Content-Type` não é `multipart/form-data`, entra no fim o corpo, nos **bytes exatos** enviados. Nunca se re-serializa o JSON entre assinar e enviar.
6. **O segredo:** `app_secret + string + app_secret`.
7. **O HMAC:** HMAC-SHA256 com a chave `app_secret`, em hexadecimal minúsculo, vai no parâmetro `sign`.

**O access token** (versão 202309 em diante) vai no cabeçalho `x-tts-access-token`, fora da assinatura.

**O `timestamp`** é em segundos, e a janela aceita vai de agora − 5 min a agora + 30 s. Fora dela, o erro é `36009004` (DA DOC, P`common-parameters`).

## 4. Autorização da loja — CONFERIDO

Fontes: P`authorization-overview-202407`, P`get-authorized-shops-202309`.

1. **Link:** `https://services.tiktokshop.com/open/authorize?service_id={service_id}&state={state}`.
   - O `service_id` fica em *App & Service > Basic Information*.
   - O link do vendedor **não** leva `app_key`.
   - O `state` é o anti-CSRF e aponta para a organização, como na Shopee.
   - Há uma Redirect URL só por app.
2. **Retorno:** `{redirect_url}?code=…&state=…`. Na recusa, `code=null&error=auth_denied`. O `code` vale **30 minutos e uma vez**.
3. **Token:** `GET https://auth.tiktok-shops.com/api/v2/token/get?app_key&app_secret&auth_code&grant_type=authorized_code`.
   - O valor é `authorized_code` mesmo, e **não** o `authorization_code` do OAuth: a doc avisa que "corrigir" quebra.
   - **O `app_secret` vai na URL:** a URL dessa chamada nunca entra em log.
   - **A resposta** traz `access_token`, `access_token_expire_in` (instante Unix), `refresh_token`, `refresh_token_expire_in`, `open_id`, `seller_name`, `seller_base_region`, `user_type` e `granted_scopes`.
4. **Validades:**
   - o access token vale **7 dias** (o padrão);
   - o refresh token vence com a duração de autorização que o vendedor escolheu (ver §14, item 2);
   - a renovação é `GET .../api/v2/token/refresh?app_key&app_secret&refresh_token&grant_type=refresh_token`, com a mesma resposta.
5. **A loja e o cipher:** `GET /authorization/202309/shops`, assinado e com o token.
   - Devolve `shops[]` com `id`, `name`, `region`, `seller_type` (LOCAL ou CROSS_BORDER), `cipher` e `code`.
   - **O `cipher` vai como `shop_cipher` em toda chamada de loja.** As referências de pedidos, financeiro, produtos e devoluções o marcam obrigatório.
   - Guarda-se também o `id`, porque o webhook traz `shop_id`, e não o cipher.

**Ciclo de vida (DA DOC, P`reauthorize-shops`):**
- O webhook `UPCOMING_AUTHORIZATION_EXPIRATION` chega 30 dias antes do fim da autorização e depois todo dia.
- `SELLER_DEAUTHORIZATION` avisa a revogação.
- A reautorização usa o mesmo link.

## 5. Parâmetros, envelope e erros — DA DOC

Fontes: P`common-parameters`, P`api-versioning`, P`common-errors`.

**Parâmetros e versões:**
- **Na query:** `app_key`, `timestamp`, `sign` e `shop_cipher`.
- **Nos cabeçalhos:** `x-tts-access-token` e `content-type: application/json`.
- **A versão é por API, no caminho** (`/{categoria}/{AAAAMM}/{recurso}`). A antiga fica no ar pelo menos 2 meses depois da nova, com aviso no changelog.

**Envelope:** `{code, message, request_id, data}`, com `code` 0 no sucesso.

**Erros que o cliente precisa distinguir:**

| Código | Significado | O que o worker faz |
|---|---|---|
| `36009002` (com HTTP 429) | limite de taxa | espera o `Retry-After` e repete |
| `36009003` | erro interno | repete |
| `105002` | token expirado | renova e repete |
| `105005` | falta escopo | erro de configuração do app |
| `106001` | `sign` inválido | erro de código |
| `106013` | falta `shop_cipher` | erro de código |
| `101000` | token de outra loja | erro de código |
| `36009033` | IP fora da lista permitida | erro de configuração do app |
| `36004004` | `auth_code` inválido | o vendedor reautoriza |

**HTTP no erro de negócio:** não confirmado (§14, item 1). O cliente olha o `code` **e** o status HTTP.

## 6. Pedidos — CONFERIDO

Fontes: P`order-api-overview`, P`get-order-list-202309`, P`get-order-detail-202507`.

**Busca:** `POST /order/202309/orders/search`.
- **Página:** `page_size` obrigatório, de 1 a 100; o cursor é `page_token` (o `next_page_token` da resposta anterior).
- **Ordem:** `sort_field` (`create_time` padrão ou `update_time`) e `sort_order` (DESC padrão).
- **Filtros, no corpo:** `update_time_ge`/`update_time_lt` (Unix, semiaberto), `create_time_ge`/`create_time_lt`, `order_status` e `shipping_type`, entre outros. Sem `update_time_lt`, vale o agora.
- **A resposta** já traz os pedidos inteiros, com `total_count`.
- A leitura por `update_time` com marco e sobreposição é o desenho da Shopee (D-426), e cabe aqui.

**Detalhe:** `GET /order/202507/orders?ids=…`, com até 50 ids (DA DOC). O preço por item com os vouchers está em `GET /order/202407/orders/{order_id}/price_detail` (DA DOC).

**Status:**
- **Os nove:** `UNPAID`, `ON_HOLD`, `AWAITING_SHIPMENT`, `PARTIALLY_SHIPPING`, `AWAITING_COLLECTION`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED` e `CANCELLED`.
- **`ON_HOLD`** é a janela de arrependimento de 1 h depois do pagamento.
- **O cancelamento:** o pedido só fica `CANCELLED` quando todos os itens são cancelados, e o reembolso total depois do envio leva a `COMPLETED` (DA DOC).
- **Webhook × API:** o webhook de status escreve `CANCEL` e não lista `PARTIALLY_SHIPPING` (DA DOC, P`1-order-status-change`). O worker relê o pedido pela API e não confia no texto do webhook.

**Itens — UMA LINHA POR UNIDADE:**
- **Sem quantidade:** `line_items[]` não tem campo de quantidade. O exemplo oficial, um pedido de 5 produtos (2 + 2 + 1), tem 5 linhas.
- **A quantidade da V3** é a contagem de linhas por SKU no pedido.
- **A chave do item** candidata é o `id` da linha, que identifica cada unidade. Se ele é estável entre leituras, não está dito: confere-se na primeira leitura real antes de usá-lo como chave.
- **Os campos:** `id`, `sku_id`, `seller_sku`, `product_id`, `sale_price`, `original_price`, `seller_discount`, `platform_discount`, `is_gift`, `display_status` e `combined_listing_skus[]`/`sub_item_info[]`.
- **O bundle virtual** (combo definido pelo vendedor) traz os SKUs de origem em `combined_listing_skus` e `sub_item_info`.
- **Valores:** vêm em string, na moeda de `payment.currency`, BRL no Brasil.

**Pagamento:** o instante é `paid_time` (Unix). `payment` traz `sub_total`, `shipping_fee`, os descontos de frete, `total_amount`, `tax` e `currency` (DA DOC).

**Quem expede:**
- **`fulfillment_type`** é `FULFILLMENT_BY_SELLER` (o vendedor expede do próprio estoque) ou `FULFILLMENT_BY_TIKTOK` (o estoque está no centro do TikTok, que expede).
- **`shipping_type`** (`TIKTOK` ou `SELLER`) diz quem transporta o pedido do vendedor.
- **O `FULFILLMENT_BY_TIKTOK` é o equivalente do Full e do armazém da Shopee** (D-352, D-495). Se ele existe no Brasil, não está confirmado (§14, item 5).

**Cancelamento (DA DOC):** `cancel_reason`, `cancellation_initiator` (SELLER, BUYER ou SYSTEM), `cancel_time`, `is_buyer_request_cancel` e `request_cancel_time`.

## 7. Financeiro — DA DOC

Fontes: P`finance-api-overview` e as páginas de cada chamada.

- **Extratos diários:** `GET /finance/202309/statements`, gerados às 00:00 UTC com o dia anterior. Trazem `settlement_amount`, `revenue_amount`, `fee_amount`, `adjustment_amount`, `shipping_cost_amount` e `payment_status`. Só há dados a partir de 01/07/2023.
- **Transações por pedido:** `GET /finance/202501/orders/{order_id}/statement_transactions`.
  - São por SKU, com quantidade.
  - Têm as quebras de receita, frete e taxas: comissão da plataforma, `referral_fee_amount`, `transaction_fee_amount`, afiliados e **`fee_per_item_sold_amount`, só no Brasil**.
  - O pedido ainda não liquidado não aparece. Para ele, `GET /finance/202507/orders/unsettled` dá a estimativa.
- **Repasses:** `GET /finance/202605/payments` e `GET /finance/202309/withdrawals`.

## 8. Catálogo — DA DOC

Fontes: P`search-products-202502`, P`get-product-202309`, P`inventory-search-202309`.

- **Busca:** `POST /product/202502/products/search`, com `page_size` de 1 a 100 e `page_token`. Filtra por `status`, `seller_skus[]` e intervalos de criação e atualização. Devolve `skus[]` com `id`, `seller_sku`, `price` e o estoque por armazém.
- **Detalhe:** `GET /product/202309/products/{product_id}`, que inclui produtos congelados e apagados.
- **Estoque:** `POST /product/202309/inventory/search`, com até 100 produtos ou 600 SKUs por chamada.
- **O vínculo com o SKU da V3** é pelo `seller_sku`, como no ML e na Shopee.

## 9. Devoluções e cancelamentos — DA DOC

Fontes: P`return-refund-and-cancel-api-overview`, P`search-returns-202602`, P`search-cancellations-202602`.

- **Devoluções:** `POST /return_refund/202602/returns/search`, com `page_size` de 10 a 50.
  - Filtra por pedido, tipo (REFUND, RETURN_AND_REFUND, REPLACEMENT, EXCHANGE), status e intervalos.
  - As linhas têm `sku_id`, `seller_sku` e `refund_amount`.
  - Há 18 status.
- **Cancelamentos:** `POST /return_refund/202602/cancellations/search`.
- **O status cancelado** difere entre webhook e API (`…_CANCELLED` × `…_CANCEL`). Aceitam-se os dois.

## 10. Webhooks — CONFERIDO

Fontes: P`tts-webhooks-overview`, P`configuration-guide`.

- **Configuração:** no Partner Center (*Basic Information > Developing*) ou pela API (`PUT`/`GET`/`DELETE /event/202309/webhooks`). As duas mexem na mesma assinatura.
- **URL:** HTTPS, com domínio e sem porta. A do Cloud Run serve.
- **Corpo:** `{type, tts_notification_id, shop_id, timestamp, data}`. No pedido (tipo 1), `data` traz `order_id`, `order_status`, `is_on_hold_order` e `update_time`.
- **Tipos que importam à leitura (DA DOC):**

  | Tipo | Evento |
  |---|---|
  | 1 | `ORDER_STATUS_CHANGE` |
  | 6 | `SELLER_DEAUTHORIZATION` |
  | 7 | `UPCOMING_AUTHORIZATION_EXPIRATION` |
  | 11 | `CANCELLATION_STATUS_CHANGE` |
  | 12 | `RETURN_STATUS_CHANGE` |
  | 36 | `INVOICE_STATUS_CHANGE` (a NF-e do Brasil) |

- **Assinatura:** no cabeçalho `Authorization`, **sem** "Bearer". É o HMAC-SHA256 hex minúsculo de `app_key + corpo bruto`, com a chave `app_secret`. Verifica-se antes de qualquer parse, sobre os bytes recebidos, e compara-se em tempo constante.
- **Resposta:** em **até 3 segundos**.
- **Retentativas:** 2 min, 30 min, 3 h e 12 h; depois da 4ª falha, para.
- **Entrega "pelo menos uma vez":** deduplica-se por `tts_notification_id`.
- **A doc manda não ter o webhook como a única fonte.** É o desenho da Shopee: o push só aciona, e a leitura periódica fecha o buraco (D-453).

## 11. Limites de taxa — DA DOC

Fonte: P`rate-limits`.

- **Cota dinâmica:** sem número fixo publicado, isolada por app × loja.
- **O sinal:** HTTP 429 e/ou o código `36009002`. Respeita-se o `Retry-After`.
- **A base de planejamento da doc, sem garantia:** leitura e sincronização de 3 a 10 requisições por segundo, por app × loja.

## 12. Loja de teste — CONFERIDO

Fonte: P`seller-center-development-shops`.

- **Brasil:** loja de desenvolvimento **local = Sim**; cross-border = Não.
- **Dois tipos de conta de teste (DA DOC, P`test-your-app`):**
  - **Core Function:** sem KYC, com pedido de teste pelo *Buyer View*, sem financeiro.
  - **Full Function:** com KYC e pagamento real, e com liquidação.
- **Limites:** até 10 contas de teste, que expiram em 180 dias.
- **Antes do Publish**, só loja de teste autoriza o app. É o caminho para ensaiar a conexão e a leitura sem tocar na loja real.

## 13. O que é do Brasil

**Campos só do Brasil no pedido (CONFERIDO, P`get-order-detail-202507`):**

| Campo | O que é |
|---|---|
| `cpf` e `cpf_name` | o CPF do comprador para a nota |
| `need_upload_invoice` | UNKNOWN, NEED_INVOICE, NO_NEED, INVOICE_UPLOADED ou INVOICE_PROCESSING |
| `payment_auth_code` | o código do cartão ou o E2E do PIX |
| `channel_entity_national_registry_id` | o CNPJ da instituição de pagamento |

**A V3 não pede nem guarda dado do comprador** (a regra da Shopee, D-426). CPF, nome, endereço e telefone ficam fora da leitura.

**NF-e (DA DOC, P`upload-invoice-202502`, P`36-invoice-status-change`):** o vendedor local envia a NF-e antes de expedir (`POST /fulfillment/202502/invoice/upload`, o XML em base64). É escrita, e fica **fora** do escopo só de leitura. Quem emite e envia hoje é o fluxo atual do vendedor.

**A guarda da D-497:**
- **Hoje:** a nota de venda do TikTok continua entrando pela importação de NF-e, porque só ML e Shopee estão em `INTERMEDIADORES_COM_BAIXA_PELO_PEDIDO`. A conciliação com a planilha segue valendo.
- **Quando a venda do TikTok baixar pelo pedido:** a raiz do CNPJ do TikTok como intermediador entra nessa lista, senão a venda baixa duas vezes.
- **O CNPJ:** lido numa NF-e real, não suposto.

## 14. NÃO CONFIRMADO

1. **O HTTP do erro de negócio:** a doc não diz se vem 200. Numa chamada sem credencial em 20/10, o levantamento viu HTTP 400 com `code` 36009004. O cliente trata os dois sinais.
2. **A validade do refresh token:** a doc diz só que segue a duração escolhida pelo vendedor. As opções de duração não estão na doc atual, e os 365 dias vêm de uma FAQ de 2022.
3. **Outros parâmetros no retorno da autorização**, além de `code`, `state` e `error`.
4. **Os nomes técnicos dos escopos**, e se há escopo só de leitura: a lista completa só aparece no console, com login.
5. **Se o `FULFILLMENT_BY_TIKTOK` existe no Brasil.** Confere-se como na D-495: pela contagem de valores na primeira leitura real.
6. **Se o fluxo novo de devolução em lote** (Aftersales e RMA) vale no Brasil.
7. **O limite de taxa por chamada:** não é publicado.
8. **Quais taxas aparecem de fato no Brasil**, além de `fee_per_item_sold_amount`.
9. **O CNPJ do comprador pessoa jurídica:** a doc só cita o CPF.
10. **O SDK oficial:** só por download, com login (Java, Go e Node.js). A V3 escreve o cliente próprio, como o `@sb/shopee`.
11. **O guia de desenvolvedor do Brasil citado no changelog:** é um link fora do domínio oficial e não foi aberto.
12. **Se a revisão de segurança é obrigatória** para o seller developer: o texto da FAQ é contraditório.

## 15. Atos do dono e fatias

**Para a fatia 1, só o dono pode** (nada disso vai em chat):

1. **Confirmar o app no Partner Center:**
   - que é um **custom app** de *seller developer* da loja Speed Bikers;
   - se já foi publicado (Publish), porque antes disso só loja de teste autoriza;
   - o `service_id`, que não é segredo.
2. **Guardar os segredos no Secret Manager** (`speedbikers-prod`): o **App Key** e o **App Secret**. Os nomes vêm na fatia 1, como `TIKTOK_SHOP_APP_KEY` e `TIKTOK_SHOP_APP_SECRET`.
3. **Pedir os escopos de leitura** na *Manage API*, se não vierem por padrão: pedidos, financeiro, produtos e devoluções.
4. **Para ensaiar**, criar uma loja de desenvolvimento local do Brasil em *Development Kits*.

**Fatia 1 em código (D-645, 22/10):**
- **O que existe:**
  - o cliente `@sb/tiktok-shop`, com a assinatura conferida no exemplo oficial;
  - as tabelas `tiktok_shops`, `tiktok_credentials` e `tiktok_oauth_states` (migration `20261022150000`);
  - `POST /v1/tiktok-shop/connect` e `GET /oauth/tiktok-shop/callback`;
  - o interruptor: sem `TIKTOK_SHOP_SERVICE_ID`, `TIKTOK_SHOP_APP_KEY` e `TIKTOK_SHOP_APP_SECRET`, as rotas respondem 503.
- **Para ligar em produção, na ordem:**
  1. a migration em produção;
  2. o dono: o app publicado; os dois segredos com esses nomes em `speedbikers-prod`; e o `secretAccessor` dos dois para a conta da api (`v3-api-runtime`);
  3. a api publicada com `TIKTOK_SHOP_SERVICE_ID`;
  4. o ADMIN conecta pela `/contas` (tela do A2, C-86).
- **O que a primeira conexão real confere:** o `user_type`, o `seller_type` e a região da loja, e os escopos concedidos. A falta de escopo só aparece na fatia 2, como o erro `105005`.

**Fatias propostas,** no desenho da Shopee (D-425), cada uma conferida antes de codificar:
- **1. Conexão:** `@sb/tiktok-shop` (assinatura e cliente, com o exemplo oficial em teste); tabelas próprias de loja, credencial cifrada e `state`; `POST /v1/tiktok-shop/connect` e `GET /oauth/tiktok-shop/callback`; `/contas`; o interruptor por variável, com 503 sem ela.
- **2. Renovação e pedidos:** a leitura por `update_time` com marco por loja, os itens contados por SKU e o `fulfillment_type` guardado.
- **3. Webhook:** `/push/tiktok-shop`, com a assinatura, a deduplicação e o acionamento da leitura.
- **4. Financeiro por pedido.**
- **5. Catálogo e vínculo pelo `seller_sku`.**
- **6. Estoque:** a baixa pede decisão do dono, como na D-495: o corte da planilha e o estoque do TikTok. O UpSeller já tem a loja TikTok cadastrada (`docs/UPSELLER.md` §2).
- **7. Devoluções.**
- **8. Canal nos relatórios e nas telas** (A2 e A3).
