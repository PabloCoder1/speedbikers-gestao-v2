# Shopee Open Platform — integração

Segundo canal da V3, **só leitura** (D-425). Este documento guarda o contrato
**conferido** na documentação oficial e o estado da integração. Narrativa e
porquê moram em `docs/DECISIONS.md` (D-425 em diante).

## 1. O app

| | |
|---|---|
| Console | `open.shopee.com` → Console → App List → "Analytics Lojas Shopee" |
| Tipo | **Seller In House System** (sistema próprio do vendedor) |
| Estado | **Live** desde 16/10/2026 (partner_id de produção `2048641`, não é segredo; Partner Key e Push Partner Key em `SHOPEE_LIVE_PARTNER_KEY` e `SHOPEE_LIVE_PUSH_PARTNER_KEY`). A loja se conecta SÓ pelo `/contas` → Conectar loja Shopee: o "Authorize" do Console volta sem o `state` e a api recusa. Antes, Developing (sandbox) desde 13/10 |
| Test partner_id | `1248019` (não é segredo) |
| Test Partner Key | Secret Manager `SHOPEE_TEST_PARTNER_KEY` (projeto `speedbikers-prod`) — **nunca** em chat, print, `.env` versionado ou Git |
| Test Redirect URL Domain | `https://api-p6gzq3hzca-rj.a.run.app` (só o domínio; o caminho vai no link) |

**Ligar em produção** (D-425, D-426): a api (conexão) e o worker (renovação
e pedidos) precisam ler o segredo — ato do dono, uma vez cada:

```bash
gcloud secrets add-iam-policy-binding SHOPEE_TEST_PARTNER_KEY --project speedbikers-prod --member serviceAccount:v3-api-runtime@speedbikers-prod.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
```

```bash
gcloud secrets add-iam-policy-binding SHOPEE_TEST_PARTNER_KEY --project speedbikers-prod --member serviceAccount:v3-worker-runtime@speedbikers-prod.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
```

Depois, o deploy da api e do worker com `SHOPEE_PARTNER_ID=1248019` no
ambiente (`infra/deploy-cloud-run.sh` monta as variáveis e o segredo só com
ele) — **feito em 13/10** (`worker-00042-k5n`, `api-00025-rbw`). O job
horário `v3-shopee-orders` (o mesmo de `infra/cloud-scheduler.sh` com
`SHOPEE_PARTNER_ID`) foi **criado em 13/10** e serve pedidos e catálogo
(D-428). Para recriá-lo, num terminal onde o `gcloud` aceite a cron com
espaço (Cloud Shell ou PowerShell; no Git Bash o `gcloud.cmd` quebra):

```bash
gcloud scheduler jobs create http v3-shopee-orders --project speedbikers-prod --location southamerica-east1 --schedule "20 * * * *" --time-zone America/Sao_Paulo --uri https://api-p6gzq3hzca-rj.a.run.app/internal/schedule/shopee-orders --http-method POST --oidc-service-account-email v3-scheduler-invoker@speedbikers-prod.iam.gserviceaccount.com --oidc-token-audience https://api-p6gzq3hzca-rj.a.run.app --max-retry-attempts 2 --min-backoff 30s --max-backoff 120s --description "Sincronizacao de pedidos da Shopee, por loja conectada"
```

## 2. Endereços — CONFIRMADO em 13/10/2026

Fontes: `open.shopee.com/developer-guide/16` (API calls), `/20` (Authorization
and Authentication), `/documents/v2/v2.shop.get_shop_info`.

| | Sandbox | Produção (Brasil) |
|---|---|---|
| API | `https://openplatform.sandbox.test-stable.shopee.sg` (não há sandbox de API brasileiro) | `https://openplatform.shopee.com.br` |
| Página de autorização | `https://open.sandbox.test-stable.shopee.com/auth` (global; o `.com.br` da tabela oficial **não existe no DNS**) | `https://open.shopee.com.br/auth` |

O `partner_id` de teste só vale no sandbox; o de produção, só em produção.

**Sandbox é global, inclusive a autorização (conferido em 13/10/2026 à tarde):**
a tabela de `developer-guide/20` lista `open.sandbox.test-stable.shopee.com.br/auth`
para o Brasil, mas o host responde `NXDOMAIN` — foi o que o dono viu ao clicar
em Conectar. A página global `open.sandbox.test-stable.shopee.com/auth` aceita
o partner_id de teste e leva ao login da conta de TESTE
(`account.sandbox.test-stable.shopee.com`), com o país no seletor. O
`open.test-stable.shopee.com/auth` do exemplo da mesma página é outro
ambiente (`account.seller.test-stable`), não o sandbox público.

## 3. Assinatura — CONFIRMADO

Toda chamada leva na query `partner_id`, `timestamp` (epoch em segundos,
**válido por 5 minutos**) e `sign`. A de loja leva também `access_token` e
`shop_id`.

`sign` = HMAC-SHA256, hexadecimal minúsculo, com a Partner Key como chave, da
concatenação **sem separador**:

- API pública: `partner_id + caminho + timestamp`
- API de loja: `partner_id + caminho + timestamp + access_token + shop_id`

O caminho vai sem host (`/api/v2/shop/get_shop_info`). A resposta traz `error`
(vazio no sucesso), `message` e `request_id` — **com HTTP 200 mesmo no erro de
negócio**: o cliente (`@sb/shopee`) olha o `error`, não só o status.

## 4. Autorização de loja — CONFIRMADO

1. **Link** (sem assinatura): endereço de autorização + `partner_id`,
   `auth_type=seller`, `redirect_uri`, `response_type=code` e `state`
   (anti-CSRF, volta intacto). O domínio do `redirect_uri` tem de ser o
   declarado no Console, senão: *"The domain of redirect_uri is not consistent
   with the Redirect URL Domain declared in console"*.
2. **O vendedor** entra com a conta da loja (ou a principal, que autoriza
   várias), confirma e escolhe a validade: 7, 30, 90, 180 ou **365 dias** (ou
   uma data dentro de 365).
3. **Retorno:** `redirect_uri?code=…&shop_id=…` — ou `&main_account_id=…` na
   conta principal. O `code` vale **uma vez, por 10 minutos**.
4. **Token** (`POST /api/v2/auth/token/get`, assinatura pública): corpo
   `{code, partner_id, shop_id}` ou `{code, partner_id, main_account_id}`.
   Devolve `access_token` (**4 h**, `expire_in` em segundos), `refresh_token`
   (**30 dias, uso único**) e, na conta principal, `shop_id_list`.
5. **Renovação** (`POST /api/v2/auth/access_token/get`): corpo
   `{refresh_token, partner_id, shop_id}`. Devolve um par NOVO; o refresh_token
   usado morre. O access_token antigo ainda vale 5 minutos. Na conta
   principal, o primeiro par é o mesmo para todas as lojas; a primeira
   renovação de cada uma devolve um par próprio.
6. **Loja** (`GET /api/v2/shop/get_shop_info`, API de loja): `shop_name`,
   `region`, `status` (NORMAL, BANNED, FROZEN), `auth_time` e `expire_time`
   (o vencimento da autorização), em epoch.

Na V3: `POST /v1/shopee/connect` (ADMIN) devolve o link;
`GET /oauth/shopee/callback` conclui — `apps/api/src/shopee-shops.ts`.
Tabelas: `shopee_shops`, `shopee_credentials` (cifrada, como
`ml_credentials`), `shopee_oauth_states` (`docs/DATABASE.md`).

## 4.1 Renovação e pedidos — CONFIRMADO (D-426)

- **Renovação** no worker, na hora de usar: com menos de 10 minutos de
  folga, trava `refresh_locked_until` (60 s) e renova com o refresh lido NA
  trava (uso único). Recusa definitiva (`refresh_token_expired`,
  `shop_access_expired`, `shop_banned`, `shop_no_linked`,
  `error_shop_refresh_token`, `error_auth`) → loja `ERROR`; o resto é
  passageiro — `apps/worker/src/handlers/shopee-token.ts`.
- **Lista** (`GET /api/v2/order/get_order_list`): `time_range_field`
  (`create_time` | `update_time`), `time_from`/`time_to` com no máximo
  **15 dias**, `page_size` até **100**, `cursor`; devolve `more`,
  `next_cursor` e `order_list[].order_sn`.
- **Detalhe** (`GET /api/v2/order/get_order_detail`): até **50**
  `order_sn` por chamada; itens e valores só com `response_optional_fields`.
  A V3 pede `item_list,total_amount,pay_time,shipping_carrier,
  payment_method,cancel_by,cancel_reason,fulfillment_flag` — nada do comprador.
  **`fulfillment_flag` — CONFIRMADO na documentação em 19/10/2026 (D-495):**
  "Use this field to indicate the order is fulfilled by shopee or seller.
  Applicable values: fulfilled_by_shopee, fulfilled_by_cb_seller,
  fulfilled_by_local_seller." `fulfilled_by_shopee` é o pedido do armazém da
  Shopee (o equivalente ao Full); guardado em `shopee_orders.fulfillment_flag`.
  A página da documentação monta no navegador: não abre para busca, só no
  navegador embutido.
  `total_amount` não vem antes do pagamento (fica NULO).
- **Na V3:** job `shopee.orders.sync` por loja, janela por `update_time` a
  partir de `shopee_shops.orders_synced_until` menos 10 minutos; a primeira
  leitura começa 90 dias atrás e encadeia janelas de 15 dias. Gatilho
  horário `POST /internal/schedule/shopee-orders`. Tabelas
  `shopee_orders` e `shopee_order_items` (`docs/DATABASE.md`).
- **Gravação (D-432):** cada lote de 50 vai numa transação
  (`shopee_upsert_orders`: pedido, itens substituídos e SKU), e a leitura
  com `update_time` mais velho que o guardado é ignorada — duas execuções
  na mesma loja podem se cruzar. O marco só anda para a frente
  (`shopee_advance_orders_synced_until`). Janela acima de 200 páginas falha
  sem repetir.

## 4.2 Financeiro do pedido — CONFIRMADO (D-427)

- **`GET /api/v2/payment/get_escrow_detail`**, um `order_sn` por chamada.
  `response.order_income` traz `escrow_amount` (o que a loja recebe — **muda
  até o pedido completar**), `buyer_total_amount`, `commission_fee`,
  `service_fee`, `seller_transaction_fee`, `net_commission_fee` e
  `net_service_fee` (só vendedor local do Brasil), o frete
  (`actual_shipping_fee`, `buyer_paid_shipping_fee`,
  `shopee_shipping_rebate`, `final_shipping_fee` — pode ser negativo —,
  `reverse_shipping_fee`), descontos e cupons por quem bancou, afiliados
  (`order_ams_commission_fee`), `seller_order_processing_fee` e ajustes.
  Fora dele: `buyer_user_name` e `buyer_payment_info` — a V3 não guarda.
- **Lote** (`get_escrow_detail_batch`, até 50): a referência se contradiz
  no formato da resposta; usar só depois de conferido no sandbox.
- **Erros — CONFERIDO na referência em 14/10/2026 (D-432):**
  `order_not_found`, `error_data` e `common.error_not_found` ("supplier
  order item income not found", vem COM o prefixo) = pedido sem financeiro
  (não é falha); `error_server` e `error_network` = passageiros;
  `error_param` = recusa daquele pedido (fica em `financials_error`, volta
  em 1 dia ou quando ele mudar, e a fila segue). Os códigos comuns —
  `error_auth` (token, partner, permissão), `error_sign`, `error_shop`,
  `invalid_partner_id`, `invalid_acceess_token` (grafia da documentação) —
  são da LOJA: interrompem a tarefa sem marcar pedido
  (`isShopLevelError` em `@sb/shopee`; vale também para o catálogo).
- **Na V3:** job `shopee.order-financials.sync` (até 100 pedidos por
  execução), enfileirado por `shopee.orders.sync` quando os pedidos
  alcançam agora; quem precisa de leitura é
  `shopee_orders_financials_pending` (pago e nunca lido, alterado depois da
  leitura, ou aberto e lido há mais de 24 h). Colunas e `order_income`
  inteiro em `shopee_orders`.

## 4.2b Devoluções — CONFIRMADO na documentação (D-447)

- **`GET /api/v2/returns/get_return_list`** (referência, guia "Return
  Refund Management" e "V2.0 Data Definition", conferidos em 14/10/2026):
  janela de `update_time` ou `create_time` de no máximo 15 dias; até 100
  por página, `page_no` + `more` (a referência diz que começa em 0, o
  exemplo usa 1 — **conferir no sandbox**). Um pedido pode ter várias
  devoluções (`return_sn`).
- **Situações:** REQUESTED, ACCEPTED, CANCELLED, JUDGING, CLOSED,
  PROCESSING, SELLER_DISPUTE — só os nomes; a documentação não diz em
  qual o reembolso foi pago. `return_solution`: 0 devolução e reembolso,
  1 só reembolso. Permissão: o app Seller In House System pode chamar.
- **Na V3:** job `shopee.returns.sync` (encadeado pelo de pedidos), tabelas
  `shopee_returns`/`shopee_return_items` **sem o comprador** (nome,
  e-mail, foto), sem as fotos e sem o texto livre; leitura por
  `get_shopee_returns` e `get_shopee_returns_summary`.

## 4.2c Ads — CONFIRMADO na documentação (D-449)

- **`GET /api/v2/ads/get_all_cpc_ads_daily_performance`** (referência e
  "Shopee On-Platform Ads API Guide", 14/10/2026): o desempenho diário dos
  anúncios CPC da LOJA — impressões, cliques, pedidos, itens, GMV direto
  e amplo (7 dias depois do clique), gasto. Datas `DD-MM-YYYY`, até 1
  mês por chamada, até 6 meses atrás, início ≠ fim. Erros: `error_not_found`
  (sem dado), `ads.performance.*` (período), `ads.rate_limit.*`
  (passageiro). Permissão: Seller In House System.
- **GMV Max de loja** (`POST get_gms_campaign_performance`): só o agregado
  do período, exige loja habilitada; **não se sabe se o gasto está no CPC
  da loja** — conferir com loja real.
- **Na V3:** job `shopee.ads.sync` (encadeado pelo de pedidos, no máximo a
  cada 3 h), `daily_shopee_ads_metrics` com a cobertura da leitura; leitura
  por `get_shopee_ads_overview` e `get_shopee_ads_daily`.

## 4.2d Repasse e extrato — CONFERIDO na documentação (D-451)

- **`GET /api/v2/payment/get_escrow_list`** (14/10/2026): os pedidos cujo
  escrow foi LIBERADO numa janela de `escrow_release_time`, com
  `payout_amount` ("the settlement amount"). Sem janela máxima declarada
  (a V3 usa 15 dias); 100 por página, `page_no` a partir de 1, `more`. O
  exemplo traz o valor inteiro (57334) e a tabela, `float` — **conferir a
  unidade no sandbox** contra o `escrow_amount`. Permissão: Seller In House.
- **`get_payout_detail` / `get_payout_info`:** só vendedor internacional (CB).
- **`get_wallet_transaction_list`** (extrato, só loja local): janela de 15
  dias; tipos (escrow liberado, saque, ajuste, cobrança de Ads, escrow
  rápido...); traz `buyer_name`; **sem identificador da transação** e com
  `page_no` descrito como deslocamento — fica para depois do sandbox.
- **`get_income_overview` / `get_income_detail`** (out/2025): pendente e
  liberado como no Seller Center; o detalhe se contradiz no formato da
  resposta — fica para depois do sandbox.
- **Na V3:** job `shopee.escrow-releases.sync` (encadeado pelo de pedidos),
  `shopee_escrow_releases` com a cobertura da leitura; leitura por
  `get_shopee_repasse_overview`, `_daily`, `get_shopee_repasses` e
  `get_shopee_repasse_pendente`.

## 4.3 Catálogo — CONFIRMADO (D-428)

- **Lista** (`GET /api/v2/product/get_item_list`): `offset` e `page_size`
  (até **100**), `item_status` obrigatório e **repetido**
  (`item_status=NORMAL&item_status=UNLIST`; NORMAL, UNLIST, BANNED,
  REVIEWING, SELLER_DELETE, SHOPEE_DELETE), `update_time_from`/`_to`
  opcionais. Devolve `item[] {item_id, item_status, update_time}`,
  `has_next_page`, `next_offset`, `total_count`. Há limite de offset
  ("use the next field"): seguir sempre o `next_offset`.
- **Detalhe** (`GET /api/v2/product/get_item_base_info`): até **50** em
  `item_id_list`, separados por vírgula. Traz `item_name`, `item_sku` (o
  SKU "pai"), `has_model`, `image`, `stock_info_v2.summary_info`; `price_info`
  **não vem** quando o item tem variação.
- **Variações** (`GET /api/v2/product/get_model_list`): um item por
  chamada. `model[] {model_id, model_sku, model_status, tier_index,
  price_info, stock_info_v2}` e `tier_variation[]` (o nome da variação sai
  das opções pelos índices).
- **Na V3:** `shopee.items.sync` (lista; sem marco, o catálogo vivo inteiro;
  com `shopee_shops.items_synced_until`, a janela desde ele com todos os
  status, sem fim de janela, conferindo o `total_count`) e
  `shopee.items.hydrate` (detalhe e variações, uma cadeia por loja,
  escolhidos por `shopee_items_details_pending`; erro definitivo de um
  item o marca e a fila segue). Pegam carona no gatilho horário dos
  pedidos, 5 minutos depois. Erros `error_inner`, `error_system_busy` e
  `error_rate_limit` são passageiros; o código vem às vezes com prefixo de
  módulo (`product.error_item_not_found`). O vínculo é o SKU do anúncio igual a `skus.sku_key`, derivado na
  view `shopee_listing_units`; tela em `/anuncios/shopee`.
- **Vínculo manual (D-429):** `shopee_sku_links`, um por unidade (variação,
  ou item sem variação), só por `set_shopee_sku_link` /
  `remove_shopee_sku_link` (ADMIN, GESTOR ou OPERADOR da organização;
  unidade no catálogo sincronizado; remover pede motivo); histórico
  `shopee_sku_link_events`. **O manual vence o SKU do anúncio** — a
  precedência está na view.

## 4.4 Push — CONFIRMADO na documentação (D-453)

- **Guia "Push Mechanism notifications"** (developer-guide/18, 14/10/2026):
  POST ao endereço cadastrado no Console; `Authorization` = HMAC-SHA256
  (hex) da chave do parceiro sobre `<endereço>|<corpo cru>`; resposta 2xx
  de corpo VAZIO em 3 s (senão repete em 300/1800/10800 s e a taxa de
  sucesso baixa — abaixo de 30% a assinatura é desligada); sem ordem e
  com repetição; só avisa, o dado vem da API.
- **Códigos usados:** 3 `order_status_push` (`ordersn`, `status`) e 29
  `return_updates_push` (`order_sn`, `return_sn`). O 2
  (`shop_authorization_canceled_push`) tem exemplos contraditórios: só log.
- **Na V3:** `POST /push/shopee` na api antecipa `shopee.orders.sync` ou
  `shopee.returns.sync` da loja, uma tarefa por janela de 5 minutos; o
  gatilho horário continua. Cadastro no Console: `docs/DEPLOYMENT.md` §6.2.
- **Recusa diagnosticável (15/10):** os 3 primeiros pushes reais (verificação e
  "Push Test Data" de 3 e 29) foram recusados; o log da recusa passou a dizer
  se o cabeçalho veio, o formato, o tamanho, as chaves e o código (sem o valor),
  e a assinatura aceita só variações de FORMA do endereço (barra, esquema) e o
  corpo sem a quebra final — sempre com a chave do parceiro.
- **Resolvido (15/10):** as amostras conferiram com a *Test Push Partner Key*
  no formato `endereço|corpo` da documentação; com o segredo montado
  (`api-00033-mwl`), um push assinado por ela é aceito. A amostra temporária
  saiu do log.
- **A chave do push é OUTRA (15/10):** a tela Set Push tem a *Test Push
  Partner Key*; as amostras gravadas na recusa não conferem com a Partner Key
  em nenhuma combinação. Segredo `SHOPEE_TEST_PUSH_PARTNER_KEY`, montado na
  api como `SHOPEE_PUSH_PARTNER_KEY` (`docs/DEPLOYMENT.md` §6.2).

## 5. Sandbox — o roteiro

Fonte: `open.shopee.com/developer-guide/644` (Sandbox Testing V2) e `/744`.

1. Console → **Tools → Test Account-Sandbox v2** → criar conta do tipo
   **Shop**, mercado **Brasil (local)** — não *Merchant* nem *cross-border*.
2. **Login Seller Center** ao lado da loja criada → My Products → criar e
   publicar um produto.
3. Console → **Test Order** → Create Test Order (loja, item, envio). O pedido
   aparece no Seller Center em ~5 minutos; "Arrange shipment" na aba *To Ship*.
4. Autorizar a loja de teste com o **link gerado pela V3** (`/contas` → Lojas
   Shopee → Conectar), entrando com a conta da loja de TESTE — conta real dá
   *"Account/Password Verification Failed"*.

## 6. Go Live — o que a Shopee exige

Fonte: `open.shopee.com/developer-guide/741` e `/742`.

- **Lista de IPs (obrigatória para todos):** declarar os IPs que chamam a API
  e ligar *Enable IP Address Whitelist*; depois disso, só eles chamam. O Cloud
  Run saía por IP dinâmico; desde 15/10 api e worker saem pelo Cloud NAT com
  o IP fixo **`34.95.145.35`** (D-457, `docs/DEPLOYMENT.md` §6.3) — é ele que
  vai na lista. Ligar a lista só depois dos dois saírem por ele (feito).
- Product Brief: URL da solução, usuário e senha de teste, descrição, print.
- Live Redirect URL Domain.
- Declaração de infraestrutura: IPs dos servidores de banco de dados e outros.
- Dados do comprador (nome, telefone, endereço) vêm **mascarados** sem o
  acesso a *Sensitive Data* — a V3 não precisa deles para relatório.

## 7. Estado das fatias

| Fatia | O quê | Estado |
|---|---|---|
| 0–1 | Decisão, `@sb/shopee`, conexão da loja (link, retorno, tokens cifrados, loja em `/contas`) | código (D-425) |
| 2 | Renovação automática do token + pedidos (lista e detalhe, janela horária, histórico) | código (D-426) |
| 3 | Financeiro do pedido (comissão, taxa, frete, líquido — `payment/get_escrow_detail`) | código (D-427) |
| 4 | Produtos e vínculo com SKU: 4a catálogo e vínculo pelo SKU do anúncio; 4b vínculo manual, painel no SKU, `/contas`; os ~3.000 do UpSeller vão para a fatia 7 | 4a no ar no sandbox (D-428); 4b código (D-429) |
| 5 | Estoque (a planilha do UpSeller já desconta a venda Shopee) | adiada para o Go Live (decisão do dono, 14/10) |
| 6 | Canal como dimensão em Vendas, Faturamento e ranking; painel por loja: 6a definição da venda, SKU gravado e `/vendas/shopee`; 6b canal em Faturamento e ranking | 6a código (D-430) |
| 7 | Go Live (seção 6) e autorização das lojas reais (Speedbikers, Sbmotos) | **no ar desde 16/10** (duas lojas reais; seção 8) |
| E1 | Ingestão robusta antes do volume real: pedido recusado não trava o financeiro, lote de pedidos numa transação que não regride, marco monotônico, erro da loja interrompe, organização amarrada à loja (`docs/MULTICHANNEL_CONTRACTS.md` §7) | código (D-432) |
| E2 | Permissão por loja: a mesma regra das contas ML (ADMIN todas; os demais, as concedidas), auditada, com convite e limpeza na saída (`docs/MULTICHANNEL_CONTRACTS.md` §7) | código (D-433) |
| E3 | `marketplace_accounts` (contas ML e lojas numa fonte, com a permissão) e a loja parada avisando como a conta ML: vigia de 3/12 h pelo avanço do marco e ERROR na hora, só loja `live`, só a quem alcança a loja | código (D-435) |
| E4 | Vendas por marketplace e o consolidado (6b, vendas): `get_marketplace_sales_summary` e `_daily`, só o que soma, sandbox e loja nunca lida fora das somas, ML idêntico a `get_sales_summary` | código (D-436) |
| E5 | Faturamento Shopee: resultado = recebido − custo nos cobertos, definitivo e provisório separados, imposto do dia; custo pela regra de D-356, provado equivalente | código (D-437) |
| E6a | Vendas por SKU entre marketplaces: o grão de SKU da Shopee (`shopee_sales_items`), o ranking por SKU com o total e as vendas de um SKU por conta e loja; ABC (E6b) e `/produtos`/ranking com resultado (E6c) depois | código (D-439) |
| E6b | Curva ABC por marketplace: marketplace e conta/loja como recortes nas três funções da Curva ABC (a tela, o painel do Excel e a aba por conta), com o ML idêntico; critério `compras`; `pedidos`, cobertura e Full só com o ML | código (D-441) |
| C-61 | Composição do faturamento (pedido do A2): a cascata do recebido pelos termos da fórmula oficial do escrow com `outros`, a série diária e o por SKU sem rateio; o TOTAL do C-58 somando como a linha; o C-58 ~150x mais rápido | código (D-443) |
| E6c | `/produtos` com a Shopee: anúncio vinculado e venda de 90 dias por SKU (só loja live), filtros, facetas e resumo olhando os dois marketplaces, o só do ML à parte | código (D-445) |
| E7a | Devoluções: a API `returns` em tabela própria, sem o comprador, com a situação como veio, o SKU de cada item, a lista e o resumo por situação | código (D-447); chamada real a conferir no sandbox depois do deploy |
| E7b | Ads CPC da loja: o desempenho diário com a cobertura da leitura, ROAS/ACOS/TACoS no SQL; fora do resultado até conferir o GMV Max com loja real | código (D-449); chamada real a conferir no sandbox depois do deploy |
| E7c | Repasse: cada liberação do escrow por pedido (`get_escrow_list`) contra o previsto, com a cobertura da leitura; o a liberar; extrato da carteira e renda por pedido esperam o sandbox | código (D-451); chamada real e unidade do valor a conferir no sandbox depois do deploy |
| E7d | Push: `POST /push/shopee` assinado antecipa a leitura de pedidos (3) e devoluções (29) da loja em janelas de 5 minutos; o gatilho horário continua | código (D-453); cadastrar o endereço no Console depois do deploy da api |

## 8. A primeira leitura real — auditoria (16/10/2026)

Duas lojas reais conectadas em 16/10 (`shop_id` 427275919 e 303898206). Consultas só de leitura em produção, agregadas, sem dado de comprador; **o repositório é público, então só proporções** (volume e receita ficam fora daqui).

| O quê | Resultado |
|---|---|
| Pedidos | 90 dias lidos por `update_time` na primeira rodada; nenhuma janela com erro |
| Financeiro (`get_escrow_detail`) | **100%** das vendas válidas lidas; nenhum `financials_error`; nenhuma válida sem receita |
| Vínculo com SKU | ~0,7% dos itens sem SKU (os não vinculados vão para `/vinculacoes`) |
| Catálogo | lido inteiro, nenhum `details_error` |
| Credenciais | autorização até 16/10/2027; o token de 4 h renovado sozinho no modo live (D-426) |
| Devoluções, repasses, Ads | lidos; **Ads CPC funciona no live** (90 dias; o 503 era só do sandbox, D-475) |
| Faturamento (30 dias) | **99% dos pedidos válidos cobertos**; custo pelo histórico em todos |
| Repasse (C-64) | o liberado igual ao `escrow_amount` em todos os pedidos sem devolução; só os com devolução divergem (o reembolso), como o C-64 mostra |

**Três achados:**
1. **"Outros" = a taxa de proteção de envio.** Em 30 dias, o "outros" do C-61 era 0,46% da receita coberta e aparecia em quase todo pedido. **Em 100% dos pedidos cobertos ele é exatamente `shipping_seller_protection_fee_amount`** (R$ 0,49 fixo por pedido), um campo do `order_income` que a fórmula oficial do `escrow_amount` usada no C-61 não lista. Fora ele, a fórmula fecha centavo a centavo. O resultado (recebido − custo) não muda; muda a decomposição. **D-483:** componente próprio no C-61 (`protecao_envio`), em duas fases combinadas com o A2 — fase 1 com o `outros_restante` calculado no SQL e o `outros` de sempre — **em produção desde 16/10: o restante zerou em 100% dos cobertos**; fase 2 (o próprio `outros` sem a taxa) também em produção desde 16/10, depois da tela.
2. **Ajustes pós-escrow cobrados fora do repasse.** `total_adjustment_amount` (negativo, ~0,4% da receita coberta em 30 dias) não entra no repasse: a Shopee libera o `escrow_amount` cheio e cobra o ajuste à parte (provavelmente na carteira, que ainda não lemos). O C-58 mostrava os ajustes como informativos; o resultado não os descontava. **D-485 (decisão delegada pelo dono, 16/10):** o resultado desconta os ajustes (`ajustes_cobertos` no C-58, para o degrau na tela) e o financeiro é relido uma vez depois da liberação do repasse. Em produção desde 19/10, depois da tela do A2 (D-498).
3. **Nenhuma alíquota de imposto cadastrada** (`tax_rates` vazia em produção): o imposto sai nulo no ML e na Shopee. Ato do dono, em `/central/metas` (Metas e imposto).

## 9. Os três primeiros dias em produção (16 a 19/10/2026)

Leitura de 19/10, só agregada (banco de produção e Cloud Logging), sem dado de comprador.

| O quê | Resultado |
|---|---|
| Lojas live | as duas `CONNECTED`, `NORMAL`, sem `last_error`; pedidos, repasses e devoluções a 3 minutos de agora; Ads lido até hoje; autorização por mais 362 dias |
| Financeiro | fila vazia nas duas, nenhum pago sem financeiro, nenhum `financials_error`; `total_adjustment_amount` presente em 100% das leituras (cerca de 5% dos pedidos têm ajuste) |
| Releitura da D-485 | nenhuma liberação de repasse posterior à última leitura do pedido: a fila de hoje já relê o pedido quando ele conclui; a regra da D-485 fica de rede de segurança |
| Push live (D-453) | chega das duas lojas; os códigos 3 (pedido) e 29 (devolução) antecipam a leitura; nenhum push recusado na assinatura; os demais códigos são ignorados como previsto |
| Falhas do worker | 5 falhas de jobs da Shopee em 3 dias, todas na 1ª tentativa e resolvidas na 2ª, 30 s depois: 3 `JWT issued at future` na leitura da loja (relógio do lado do Supabase, transitório) e 2 renovações de token concorrentes |
| Mercado Livre | as 4 contas reconciliadas a 9 minutos de agora; as falhas são as de antes do Go Live (404 de pergunta ou reclamação apagada, 429 isolado) e um pico de 409 "capacidade interna" do ML nas promoções, num único minuto |
| Ainda pendente | nenhuma alíquota cadastrada (ato do dono, `/central/metas`). As migrations da D-485 e da D-487 entraram em 19/10, depois da D-498 |
