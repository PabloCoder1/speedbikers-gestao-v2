# Shopee Open Platform — integração

Segundo canal da V3, **só leitura** (D-425). Este documento guarda o contrato
**conferido** na documentação oficial e o estado da integração. Narrativa e
porquê moram em `docs/DECISIONS.md` (D-425 em diante).

## 1. O app

| | |
|---|---|
| Console | `open.shopee.com` → Console → App List → "Analytics Lojas Shopee" |
| Tipo | **Seller In House System** (sistema próprio do vendedor) |
| Estado | **Developing** (sandbox) desde 13/10/2026 — Go Live pendente (seção 6) |
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
  payment_method,cancel_by,cancel_reason` — nada do comprador.
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
  Run sai por **IP dinâmico** → precisa de **Cloud NAT com IP fixo** antes do
  Go Live (decisão de custo do dono; resolve também o 403 por instância do
  Mercado Livre).
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
| 7 | Go Live (seção 6) e autorização das lojas reais (Speedbikers, Sbmotos) | — |
| E1 | Ingestão robusta antes do volume real: pedido recusado não trava o financeiro, lote de pedidos numa transação que não regride, marco monotônico, erro da loja interrompe, organização amarrada à loja (`docs/MULTICHANNEL_CONTRACTS.md` §7) | código (D-432) |
| E2 | Permissão por loja: a mesma regra das contas ML (ADMIN todas; os demais, as concedidas), auditada, com convite e limpeza na saída (`docs/MULTICHANNEL_CONTRACTS.md` §7) | código (D-433) |
| E3 | `marketplace_accounts` (contas ML e lojas numa fonte, com a permissão) e a loja parada avisando como a conta ML: vigia de 3/12 h pelo avanço do marco e ERROR na hora, só loja `live`, só a quem alcança a loja | código (D-435) |
| E4 | Vendas por marketplace e o consolidado (6b, vendas): `get_marketplace_sales_summary` e `_daily`, só o que soma, sandbox e loja nunca lida fora das somas, ML idêntico a `get_sales_summary` | código (D-436) |
| E5 | Faturamento Shopee: resultado = recebido − custo nos cobertos, definitivo e provisório separados, imposto do dia; custo pela regra de D-356, provado equivalente | código (D-437) |
