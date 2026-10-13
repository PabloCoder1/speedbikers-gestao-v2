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

**Ligar na api de produção** (D-425): a conta da api precisa ler o segredo —
ato do dono, uma vez:

```bash
gcloud secrets add-iam-policy-binding SHOPEE_TEST_PARTNER_KEY --project speedbikers-prod --member serviceAccount:v3-api-runtime@speedbikers-prod.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
```

Depois, o deploy da api com `SHOPEE_PARTNER_ID=1248019` no ambiente
(`infra/deploy-cloud-run.sh` monta as variáveis e o segredo só com ele).

## 2. Endereços — CONFIRMADO em 13/10/2026

Fontes: `open.shopee.com/developer-guide/16` (API calls), `/20` (Authorization
and Authentication), `/documents/v2/v2.shop.get_shop_info`.

| | Sandbox | Produção (Brasil) |
|---|---|---|
| API | `https://openplatform.sandbox.test-stable.shopee.sg` (não há sandbox de API brasileiro) | `https://openplatform.shopee.com.br` |
| Página de autorização | `https://open.sandbox.test-stable.shopee.com.br/auth` | `https://open.shopee.com.br/auth` |

O `partner_id` de teste só vale no sandbox; o de produção, só em produção.

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
| 2 | Renovação automática do token + pedidos (lista e detalhe, janela horária, histórico) | — |
| 3 | Financeiro do pedido (comissão, taxa, frete, líquido — `payment/get_escrow_detail`) | — |
| 4 | Produtos e vínculo com SKU (SKU do vendedor; os ~3.000 vínculos Shopee do UpSeller) | — |
| 5 | Estoque (exige decisão do dono: a planilha do UpSeller já desconta a venda Shopee) | — |
| 6 | Canal como dimensão em Vendas, Faturamento e ranking; painel por loja | — |
| 7 | Go Live (seção 6) e autorização das lojas reais (Speedbikers, Sbmotos) | — |
