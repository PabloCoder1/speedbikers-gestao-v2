# Integração Mercado Livre — Speed Bikers Gestão V3

> Dono documental de: estratégia de sincronização, regras de integração e registro de endpoints.
> Status: **estratégia aprovada. Lista de verificação da secao 1 confirmada em 2026-08-21, exceto visitas/Ads (não bloqueia — necessários só na Fase 5B, D-032). Fase 3 desbloqueada.**

---

## REGRA ABSOLUTA

**Nunca inventar endpoint, payload, escopo, política ou comportamento da API do Mercado Livre** (`docs/PROMPT_MASTER.md` §9).

Antes de implementar qualquer integração que dependa de comportamento atual:

1. consultar a documentação oficial vigente;
2. registrar o endpoint e o escopo **neste arquivo**;
3. considerar paginação, rate limit, erros e idempotência;
4. escrever teste com fixture gravado.

Este arquivo tem seções deliberadamente vazias quando o item ainda não foi verificado. **Seção vazia é sinal de trabalho pendente, não de esquecimento.** Preenchê-la com suposição é pior que deixá-la vazia.

---

## 1. Lista de verificação

Confirmado na documentação oficial (`developers.mercadolivre.com.br`, consulta em 2026-08-21, salvo indicação em contrário):

- [x] Tópicos de webhook disponíveis atualmente e seus payloads — secao 2.4
- [x] Mecanismo oficial de recuperação de notificações perdidas — secao 2.5
- [x] Política de rate limit vigente: limites, janelas e cabeçalhos de resposta — secao 2.3 (**sem números fixos publicados** — ver decisão associada)
- [x] Modelo de autorização multi-conta — secao 2.2 (**confirma viabilidade da autorização centralizada pelo ADMIN**, `docs/PROMPT_MASTER.md` §10)
- [x] Endpoints e paginação de pedidos — secao 2
- [x] Identificadores `MLB`, `variation_id` e `MLBU` — confirmados em 2026-08-20, secao 2.1
- [x] Endpoints e paginação de anúncios e variações — secao 2
- [x] Endpoints de estoque Full — secao 2.7
- [x] Endpoints de promoções e catálogo — secao 2.8
- [ ] Endpoints de visitas e de Ads — necessários apenas na Fase 5B (D-032); ainda não pesquisados, **não bloqueia a Fase 3**
- [x] Escopos de OAuth necessários por recurso — secao 2.9
- [x] Política de validação de origem do webhook — secao 2.6 (allowlist de IP; **sem assinatura HMAC documentada** para este produto)
- [x] Endpoints de pós-venda (Claims/Returns) — secao 2.10 (D-057)

---

## 2. Registro de endpoints

| Recurso | Endpoint | Escopo / permissão | Paginação | Rate limit | Confirmado em |
|---|---|---|---|---|---|
| Detalhe de pedido | `GET /orders/{order_id}` | `read`, "Vendas e envios" | — | secao 2.3 | 2026-08-21 |
| Busca de pedidos | `GET /orders/search?seller={seller_id}&...` | `read` | `offset`/`limit` (padrão 50); **teto não documentado** | secao 2.3 | 2026-08-21 |
| Filtro de pedidos por data | `order.date_last_updated.from`/`.to`, `order.date_created.from`/`.to`, `order.date_closed.from`/`.to` — ISO8601 com offset | `read` | mesma de busca de pedidos | secao 3 | 2026-08-21 |
| Envios do pedido | `GET /orders/{order_id}/shipments` | `read` | — | secao 2.3 | 2026-08-21 (formato muda em set/2026, ver secao 7) |
| Descontos do pedido | `GET /orders/{order_id}/discounts` | `read` | — | secao 2.3 | 2026-08-21 |
| Itens do vendedor (recomendado) | `GET /users/{user_id}/items/search` | `read`, "Publicação e sincronização" | `offset`/`limit` padrão 50; `search_type=scan` + `scroll_id` acima de 1000, até 100/página, scroll expira em 5 min | secao 2.3 | 2026-08-21 |
| Itens do vendedor (legado) | `GET /sites/{site_id}/search?seller_id=...` | `read` | idem acima | secao 2.3 | 2026-08-21 — documentação indica substituição gradual pelo endpoint acima |
| Filtro por user product | `GET /users/{seller_id}/items/search?user_product_id=MLBU1,MLBU2` | `read`, privado | — | secao 2.3 | 2026-08-20 |
| Multiget de itens | `GET /items?ids=ID1,ID2&attributes=...` | `read` | até **20 ids** por chamada | secao 2.3 | 2026-08-21 |
| Item único | `GET /items/{item_id}` | `read` | — | secao 2.3 | 2026-08-20, campos de listing (`title`/`status`/`price`/`available_quantity`/`category_id`) confirmados em 2026-08-23 (D-058) |
| Variações de um item | `GET /items/{item_id}/variations` | `read` | — | secao 2.3 | 2026-08-21 |
| Variação específica | `GET /items/{item_id}/variations/{variation_id}` | `read` | — | secao 2.3 | 2026-08-21 |
| Estoque Full agregado | `GET /inventories/{inventory_id}/stock/fulfillment` | `read`, "Vendas e envios" | — | secao 2.3 | 2026-08-21 |
| Operações de estoque Full | `GET /stock/fulfillment/operations/search?...` | `read` | `scroll` (expira 5 min); até **1000/página**; janela máx. **60 dias** | secao 2.3 | 2026-08-21 |
| Estoque multi-origem próprio | `GET /user-products/{user_product_id}/stock` | `read` | — | secao 2.3 | 2026-08-21 |
| Promoções ativas de um item | `GET /seller-promotions/items/{item_id}?app_version=v2` | `read`, "Promoções, cupons e descontos" | — | secao 2.3 | 2026-08-21 |
| Promoções do vendedor | `GET /seller-promotions/users/{user_id}?app_version=v2` | `read` | — | secao 2.3 | 2026-08-21 |
| Itens de uma campanha | `GET /seller-promotions/promotions/{promotion_id}/items?...` | `read` | `search_after` (TTL 5 min), limite **50** | secao 2.3 | 2026-08-21 |
| Buscador de produtos de catálogo | `GET /products/search?product_identifier=/q=&site_id=` | `read` | `offset`/`limit` | secao 2.3 | 2026-08-21 |
| Notificações perdidas | `GET /missed_feeds?app_id=&topic=&offset=&limit=` | — | padrão **10**; retenção **2 dias**; `site_id` obrigatório para `topic=items` | — | 2026-08-21 |
| Detalhe de claim | `GET /post-purchase/v1/claims/{claim_id}` | `read`, "Vendas e envios" ou "Comunicação pré e pós-venda" | — | secao 2.3 | 2026-08-23 |
| Detalhe de devolução | `GET /post-purchase/v2/claims/{claim_id}/returns` | `read`, mesma acima | — | secao 2.3 | 2026-08-23 |
| Autorização OAuth | `GET https://auth.mercadolivre.com.br/authorization?...` | — | — | — | 2026-08-21 |
| Token OAuth | `POST https://api.mercadolibre.com/oauth/token` | — | — | — | 2026-08-21 |
| Grants da aplicação | `GET /applications/{app_id}/grants` | — | — | — | 2026-08-21 |
| Apps autorizados por usuário | `GET /users/{user_id}/applications` | — | — | — | 2026-08-21 |
| Revogar autorização | `DELETE /users/{user_id}/applications/{app_id}` | — | — | — | 2026-08-21 |
| Cota da aplicação | `GET /applications/{app_id}` (campo `max_requests_per_hour`) | — | — | secao 2.3 | 2026-08-21 |

---

## 2.1 Identificadores — CONFIRMADO na documentação oficial (2026-08-20)

A hierarquia tem **três** identificadores distintos, e confundi-los produz vínculo errado:

| Identificador | Formato | O que é |
|---|---|---|
| `item_id` | `MLB` + dígitos | O anúncio no marketplace |
| `variation_id` | apenas dígitos | Variação dentro do anúncio |
| `user_product_id` | `MLBU` + dígitos | Produto do catálogo **do vendedor**, que pode estar associado a **um ou mais** itens |

Pontos que a documentação oficial estabelece e que valem para o nosso desenho:

- Um `user_product` pode aparecer em **vários** itens, com preço ou parcelamento diferentes em cada um. Não é sinônimo de anúncio.
- Para consultar estoque de um item é preciso obter o `user_product_id` pelo recurso `/items`; **se o item tiver variações, ele vive dentro do array `variations`**. Isso importa para o Full na Fase 4.
- Cada `user_product` pertence a uma família (`family_id`), que agrupa vários UPs.

### O que os dados reais mostraram

A exportação do UpSeller **mistura `MLB` e `MLBU` na mesma coluna**. Medido nos 20.650 vínculos de Mercado Livre:

| Forma | Vínculos | Interpretação |
|---|---|---|
| `MLB` + variação numérica | 13.299 | Anúncio com variação real |
| `MLB` + variante repetindo o anúncio | 3.579 | Anúncio **sem** variação; o ERP repete o id |
| `MLBU` + repetindo | 3.772 | Não é anúncio: é user product |

Tratar as três formas como a mesma coisa produziria vínculo errado em **36% das linhas**. Por isso `sku_listing_links` tem `ref_kind` explícito e normaliza a variação repetida para `NULL`.

Outros fatos medidos: um `MLB` chega a ter 8 ou mais variações (231 casos); **zero combinações ambíguas** em 20.650 vínculos, o que confirma que a chave única é compatível com a realidade; e o SKU declarado no anúncio difere do SKU interno em 463 linhas — guardado em `channel_sku` como pista de vinculação automática.

---

## 2.2 Autorização multi-conta — CONFIRMADO (2026-08-21)

O fluxo é o **OAuth 2.0 Authorization Code Grant padrão** — **não existe um tipo de aplicação nem um fluxo diferente para múltiplas contas**. Uma aplicação (um `client_id`/`client_secret`) recebe um par `access_token`/`refresh_token` **distinto por cada conta de vendedor (`user_id`) que autoriza** — chamado de "Grant" na documentação.

Fluxo:

1. `GET https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256`
2. O usuário loga na conta ML a ser conectada e aprova o app. Redireciona com `code`.
3. `POST https://api.mercadolibre.com/oauth/token` (`grant_type=authorization_code`) → `access_token` (expira em **21600 s / 6 h**), `refresh_token`, `user_id`.
4. `POST https://api.mercadolibre.com/oauth/token` (`grant_type=refresh_token`) → **cada refresh invalida o `refresh_token` anterior** (uso único).

**PKCE na V3 (D-049):** treze tentativas reais sem `code_challenge`/`code_verifier`, distribuídas pelas quatro contas em 2026-08-21, chegaram ao callback mas foram recusadas na troca do token com `invalid_request`; nenhuma credencial foi criada. Depois de confirmar redirect URI, client ID e referências dos secrets, o comportamento aponta com alta confiança para PKCE habilitado na aplicação — a prova final depende de uma nova autorização real. A V3 usa sempre S256: gera um verifier aleatório por autorização, envia só o hash no passo 1, guarda o verifier cifrado em `ml_oauth_states` e o envia no passo 3. A documentação oficial define esses campos como obrigatórios quando PKCE está habilitado.

**Regra crítica confirmada pela documentação:** quem realiza o passo 1/2 precisa logar como **administrador daquela conta ML específica**. Um operador/colaborador da loja recebe o erro `invalid_operator_user_id` e o grant fica inválido.

**O que isso significa para a V3 — fecha a pendência de `docs/ARCHITECTURE.md` secao 22 e `docs/PROMPT_MASTER.md` §10:** a autorização centralizada pelo ADMIN é **tecnicamente viável**, mas com uma nuance — **não é "um login autoriza todas as lojas"**. O ADMIN da Speed Bikers precisa logar, uma vez por loja, com a credencial de administrador daquela conta específica no Mercado Livre, e conceder o grant. **Feito isso uma única vez por conta, nenhum outro usuário interno do sistema jamais reautentica** — a aplicação guarda o par `access_token`/`refresh_token` por conta no servidor (`ml_credentials`) e renova sozinha. É exatamente o modelo que o schema da Fase 2 (`ml_accounts`, `ml_credentials`, `ml_oauth_states`) já suporta. Ver **D-041**.

Endpoints de gestão do grant, úteis para a tela de administração de contas:

- `GET /applications/{app_id}/grants` — lista todas as contas que autorizaram o app, com `scopes` e `date_created`.
- `GET /users/{user_id}/applications` — apps autorizados por uma conta.
- `DELETE /users/{user_id}/applications/{app_id}` — revoga.
- Estados do grant: **Novo** (<24h), **Ativo** (chamada nos últimos 90 dias), **Inativo** (sem chamada nos últimos 90 dias).

**Sobre o Developer Partner Program (DPP):** existe, mas é um **programa de certificação/benefícios comerciais** (medalhas por elegibilidade de GMV agregado), **não** um mecanismo técnico alternativo de autorização. Não relevante para o desenho técnico agora.

### Detalhe exato da troca de token — confirmado por leitura direta da página (2026-08-21)

Requisição de troca de código (`grant_type=authorization_code`) e de refresh (`grant_type=refresh_token`) — **ambas** com:

- `Content-Type: application/x-www-form-urlencoded` (não é JSON — a página mostra `curl -d 'campo=valor'` repetido, um por parâmetro).
- Header `Accept: application/json`.

Corpo (`authorization_code`): `grant_type`, `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier` (**sempre na V3**, D-049).
Corpo (`refresh_token`): `grant_type`, `client_id`, `client_secret`, `refresh_token`.

Resposta (ambos os grants), campos exatos:
```json
{
  "access_token": "APP_USR-...",
  "token_type": "bearer",
  "expires_in": 21600,
  "scope": "offline_access read write",
  "user_id": 1234567,
  "refresh_token": "TG-..."
}
```

Erro (exemplo real da página, para `invalid_grant`):
```json
{
  "error_description": "Error validating grant. Your authorization code or refresh token may be expired or it was already used",
  "error": "invalid_grant",
  "status": 400,
  "cause": []
}
```
Campos do corpo de erro: `error` (código estável), `error_description` (texto), `status` (HTTP status repetido no corpo), `cause` (array, geralmente vazio nos exemplos vistos).

Códigos de erro documentados: `invalid_client`, `invalid_grant`, `invalid_scope`, `invalid_request`, `unsupported_grant_type`, `forbidden` (403 — inclui IP bloqueado ou scope faltando), `local_rate_limited` (429 — **específico deste endpoint**, distinto do 429 genérico de rate limit da secao 2.3), `unauthorized_client`, `unauthorized_application`.

**Prazos de validade, confirmados:**
- `access_token`: 6 horas (`expires_in: 21600`), já registrado.
- `refresh_token`: expira em **6 meses** se não for usado.
- `access_token` também é invalidado antes do prazo se: o usuário trocar a senha, a aplicação atualizar o `client_secret`, o usuário revogar a permissão, **ou** a aplicação ficar 4 meses sem nenhuma chamada a `api.mercadolibre.com`.

**Fonte:** `developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao`; `.../gerencie-seu-aplicativo`; `.../developer-partner-program`.

---

## 2.3 Rate limit — CONFIRMADO, sem números fixos publicados (2026-08-21)

A documentação oficial **não publica** um teto numérico universal de requisições por minuto/hora, nem cabeçalhos de resposta do tipo `X-RateLimit-*` ou `Retry-After`. O que é confirmado:

- Controle **por `client_id` (aplicação) e por endpoint** — não por conta de vendedor, nem pelo tamanho do payload.
- Erro `429` ao exceder o limite; recomendação oficial explícita é backoff exponencial com jitter, redução de concorrência e consolidação de chamadas.
- `GET /applications/{app_id}` retorna um campo `max_requests_per_hour` — a cota é consultável por aplicação, mas não há garantia documentada de qual valor a aplicação da Speed Bikers vai receber.
- Aumento de cota é possível por canal comercial, mediante evidência de uso legítimo.
- `scroll_id` expira e não pode ser combinado com `offset`/`limit` na mesma chamada.

**Consequência para D-036:** os "valores provisórios" das filas `ml-sync-<conta>` não têm um número oficial para substituir — **não existe** esse número publicado. Permanecem como estimativa conservadora de engenharia, ajustada por observação real de `429` registrado em `sync_errors` durante a Fase 3. Ver **D-042**.

**Fonte:** `developers.mercadolivre.com.br/pt_br/rate-limit-erro-429`; `.../gerencie-seu-aplicativo`.

---

## 2.4 Webhooks — tópicos e payload — CONFIRMADO (2026-08-21)

Tópicos relevantes para o escopo atual da V3 (o portal lista mais tópicos, fora de escopo — ex. imóveis/veículos):

| Categoria | Tópico | Relevância |
|---|---|---|
| Pedidos | `orders_v2` | Sync principal de vendas |
| Itens | `items` | Preço, título, foto, status, catálogo |
| Itens | `questions` | Perguntas/respostas |
| Itens | `stock-location` | Estoque multi-origem |
| Envios | `shipments` | Rastreio/entrega |
| Envios | `fbm_stock_operations` | Movimentações Full |
| Promoções | `public_offers`, `public_candidates` | Entrada/saída de promoção |
| Preço | `price_suggestion` | Sugestão de preço |
| Catálogo | `catalog_item_competition_status` (só AR/BR/MX), `catalog_suggestions` | Concorrência de catálogo |
| Pós-venda | `post_purchase` (`claims`, `claims_actions` via `actions`) | Reclamações |

Formato do payload (comum aos tópicos "simples"):

```json
{ "_id": "...", "resource": "/caminho_do_recurso", "user_id": "...", "topic": "...", "application_id": "...", "attempts": 1, "sent": "...", "received": "..." }
```

Tópicos "com subtópicos" (`messages`, `vis_leads`, `post_purchase`) trazem também `actions` (array) e às vezes `id` em vez de `_id`.

**O corpo não traz o objeto de negócio — só um ponteiro `resource`.** A integração faz um GET subsequente para obter o detalhe. Confirma o desenho já previsto em `docs/ARCHITECTURE.md` secao 10 (worker busca no ML após receber a notificação).

**Regra dura de tempo:** responder HTTP 200 em até **500 ms**, sem chamada de rede no handler — já é o desenho da `api`. Um tópico que falhar repetidamente pode ser **desativado por fallback**, exigindo reinscrição manual.

**Avisos de depreciação já publicados** (nenhum bloqueia a V3 hoje, registrados para não implementar campo que vai sumir):

- Subtópico `quotations` (dentro de `items`, leads imobiliários) descontinuado em 13/08/2026 — fora do domínio de bikes, citado só como sinal de que o portal deprecia webhooks ativamente.
- `resource` de `claims`/`claims_actions` passou a incluir o prefixo `/post-purchase` no path.

**Fonte:** `developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes`.

---

## 2.5 Recuperação de notificações perdidas — CONFIRMADO (2026-08-21)

- Reenvio automático do próprio Mercado Livre por até **1 hora** (até 8 tentativas) enquanto a aplicação não responder 200.
- Recuperação manual: `GET /missed_feeds?app_id={app_id}&topic=&offset=&limit=` — **retenção de apenas 2 dias**, `limit` padrão 10. Para o tópico `items`, o parâmetro `site_id` é **obrigatório** (senão HTTP 400).
- A resposta inclui `request` e `response` (com `http_code`) — permite auditar o que foi enviado e o que o servidor da Speed Bikers respondeu.

**Consequência de desenho:** a reconciliação por janela (`docs/ARCHITECTURE.md` secao 10) continua sendo a rede de segurança real — `missed_feeds` cobre só 2 dias e não substitui a reconciliação por cursor já decidida.

**Fonte:** `developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes`, secao "Histórico das notificações".

---

## 2.6 Validação de origem do webhook — CONFIRMADO (2026-08-21)

Único mecanismo documentado: **allowlist de IP de origem**.

```
54.88.218.97
18.215.140.160
18.213.114.129
18.206.34.84
35.236.253.169
35.245.91.34
35.245.20.104
35.186.182.146
```

**Não existe assinatura HMAC documentada para webhooks do Mercado Livre (marketplace).** Existe HMAC (`x-signature`, `ts`/`v1`) documentado para **Mercado Pago** — produto/portal diferente. Risco real de confusão entre os dois confirmado durante a pesquisa (buscas por "assinatura de webhook" retornam material do Mercado Pago). Registrado aqui explicitamente para não ser repetido.

**Decisão de implementação:** ver **D-043**.

**Fonte:** `developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes`.

---

## 2.7 Estoque Full (fulfillment) — CONFIRMADO (2026-08-21, re-verificado ao vivo em 2026-08-22)

- `inventory_id` vem do próprio item, campo raiz de `GET /items/{item_id}` (**não** um recurso separado). Exemplo real da documentação: `{"id": "MLB1557246024", ..., "inventory_id": "LCQI05831", ...}`. Com variações, **cada variação tem seu próprio `inventory_id`** (a doc não mostra o exemplo aninhado exato, mas confirma o comportamento em texto: "Quando o item possui variações, terá uma identificação de inventory_id por variação" — path exato dentro de `variations[]` fica para confirmar contra uma resposta real com variação, antes de codar esse ramo especificamente).
- Estoque agregado: `GET /inventories/{inventory_id}/stock/fulfillment` (**sem** prefixo `/marketplace/` — isso é de Global Selling, produto diferente, não usar) →
  ```json
  {
    "inventory_id": "LCQI05831",
    "total": 20,
    "available_quantity": 5,
    "not_available_quantity": 15,
    "not_available_detail": [{ "status": "damaged", "quantity": 2 }, ...],
    "external_references": [{ "type": "item", "id": "MLB1557246024", "variation_id": 4742223403 }]
  }
  ```
  `total = available_quantity + not_available_quantity`. `not_available_detail[].status` ∈ `damaged`/`lost`/`withdrawal`/`internal_process`/`transfer`/`noFiscalCoverage`/`not_supported`. `external_references` devolve o `item_id`/`variation_id` associado ao `inventory_id` **na própria resposta de estoque** — dá para conferir cruzado contra `sku_listing_links` sem uma segunda chamada. Retenção de 12 meses. **A V3 usa `available_quantity` como o `quantity` gravado em `fulfillment_stock_snapshots`** — é o número acionável (o que pode vender), não o total bruto incluindo avariado/perdido/em trânsito interno.
  Erros confirmados: `404 seller_product_not_found`, `400 validation_error`, `403 forbidden`, `401 unauthorized`, `429 too_many_request`, `500 internal_error`.
- Operações (histórico de movimento no Full): `GET /stock/fulfillment/operations/search?...` — janela máxima de consulta de **60 dias**, padrão 15 dias sem filtro de data; paginação por `scroll` (expira em 5 min), até **1000 registros/página**. Não usado nesta etapa (só o snapshot agregado).
- Disponível hoje apenas para **Argentina, Brasil, México, Chile e Colômbia**.

**Fonte:** `developers.mercadolivre.com.br/pt_br/envios-fulfillment` (página com "Última atualização em 10/06/2026", lida ao vivo via browser em 2026-08-22 — `WebFetch` bloqueado por 403 nessas páginas, a leitura funcionou só via navegador real); `.../estoque-multi-origem` (estoque próprio, distinto do Full, não confundir).

---

## 2.8 Promoções e catálogo — CONFIRMADO (2026-08-21)

- Promoções ativas de um item específico (caso de uso central para eventos de "entrou/saiu de promoção"): `GET /seller-promotions/items/{item_id}?app_version=v2`.
- Tipos existentes: `DEAL`, `MARKETPLACE_CAMPAIGN`, `PRICE_DISCOUNT`, `LIGHTNING`, `DOD`, `VOLUME`, `PRE_NEGOTIATED`, `SELLER_CAMPAIGN`, `SMART`, `PRICE_MATCHING`, `UNHEALTHY_STOCK`, `SELLER_COUPON_CAMPAIGN`.
- Catálogo: publicar direto (`POST /items` com `catalog_product_id` + `catalog_listing: true`) ou opt-in de item existente (`POST /items/catalog_listings`). **A sincronização de condições de venda entre item de marketplace e item de catálogo é automática e não pode ser desativada pelo vendedor.**
- Diagnóstico de sincronização de catálogo: `GET /public/buybox/sync/{item_id}` (`status: SYNC|UNSYNC`).

**Fonte:** `developers.mercadolivre.com.br/pt_br/gerenciar-ofertas`; `.../buscador-de-produtos`; `.../publicacao-no-catalogo`.

---

## 2.9 Escopos de OAuth e permissões funcionais — CONFIRMADO (2026-08-21)

Escopos do OAuth: `read`, `write`, `offline_access` (necessário para manter acesso via `refresh_token` sem reautenticação constante — usar sempre).

Além do scope, o DevCenter da aplicação exige habilitar **permissões funcionais** por recurso de negócio (senão `403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES`). Relevantes para a V3 hoje:

| Permissão funcional | Libera | Uso na V3 |
|---|---|---|
| Publicação e sincronização | `items`, `pictures`, `prices` | Catálogo/anúncios |
| Vendas e envios | `orders`, `shipments`, `claims`, `returns` | Pedidos + estoque Full + Claims/Returns (D-057, secao 2.10) |
| Promoções, cupons e descontos | `offers`, `deals` | Promoções |
| Comunicação pré e pós-venda | `questions`, `messages`, `claims`, `returns` | `claims`/`returns` já usados (D-057); `questions`/`messages` seguem Fase posterior |
| Métricas do negócio | `trends`, `highlights`, `visits` | Fase 5B (D-032) |
| Publicidade | Advertising | Fase 5B (D-032) |
| Faturamento | `invoices`, `billing` | Fora de escopo hoje |

Webhooks não têm permissão funcional própria — a assinatura de tópicos é configurada no gerenciador da aplicação (Callback URL + seleção de tópicos), não pelo OAuth scope.

**Fonte:** `developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao`; `.../permissoes-funcionais`.

---

## 2.10 Pós-venda — Claims e Returns — CONFIRMADO (leitura ao vivo, 2026-08-23)

Notificação chega pelo tópico `post_purchase` (modelo com subtópicos, secao 2.4) com `actions: ["claims"]` ou `["claims_actions"]` — as duas apontam para o MESMO recurso de detalhe; o array só diz qual tipo de novidade motivou o envio, não muda o que buscar.

```json
{
  "id": "5e2827f2-...",
  "resource": "/post-purchase/v1/claims/5108684499",
  "user_id": 123456789,
  "topic": "post_purchase",
  "actions": ["claims"],
  ...
}
```

**Detalhe do claim** — `GET /post-purchase/v1/claims/{claim_id}`. Campos usados: `resource` (`"order"` | `"payment"` | `"shipment"` | `"purchase"` — só `"order"` interessa à V3), `resource_id` (o `order_id`), `status` (`opened`/`closed`), `type` (`mediations`/`return`/`fulfillment`/`ml_case`/`cancel_sale`/`cancel_purchase`/`change`/`service`), `related_entities` (array de strings — **mecanismo oficialmente recomendado** para detectar devolução física: "se existir o valor 'return', significa que há uma devolução associada a esta reclamação". Não confiar em `type === "return"` sozinho — a doc mostra `type` como algo mais amplo (ex.: `mediations` também pode ter devolução associada via `related_entities`).

**Detalhe da devolução** — `GET /post-purchase/v2/claims/{claim_id}/returns`. Campos usados: `status` (**`"delivered"` é o gatilho de reversão de estoque** — produto fisicamente de volta; `status_money` é um campo SEPARADO para o dinheiro, não usado aqui — reversão de estoque segue a física, não o financeiro), `orders[]` (`order_id`, `item_id`, `variation_id`, `context_type` — `total`/`partial`/`incomplete`, `total_quantity`, `return_quantity` — ambas chegam como STRING, convertidas com `z.coerce.number()`).

**Mapeamento para `order_items` da V3**: `orders[].item_id`/`variation_id` batem direto com `order_items.item_id`/`variation_id` (mesmo formato — MLB + variation numérica) — dá pra localizar a POSIÇÃO do item sem depender de `sku_listing_links`.

**Fonte:** `developers.mercadolivre.com.br/pt_br/gerenciar-reclamacoes`, `.../gerenciar-devolucoes`, `.../produto-receba-notificacoes`.

---

## 3. Estratégia de sincronização

Aprovada e independente dos detalhes de endpoint. Três canais com papéis que nunca se confundem:

| Canal | Papel | Gatilho | Fila |
|---|---|---|---|
| **Webhook** | Frescor — caminho **principal** | Notificação do ML | `ml-sync` |
| **Reconciliação** | Rede de segurança do que o webhook perdeu | Cloud Scheduler, janela por cursor | `ml-sync` |
| **Backfill** | História, retomável | Manual ou agendado | `backfill`, prioridade baixa |

A V2 chegou a esse desenho **por último**, depois de sofrer com o inverso: cron como caminho principal, uma conta por invocação e intervalo de 4 min, resultando em ~16 min de defasagem por conta. O dashboard chegou a mostrar 28 pedidos / R$ 2.201 quando a tabela de pedidos já tinha 110 pedidos / R$ 9.532 — 4x a menos. Não era erro de cálculo, era latência de agendamento.

A V3 nasce com o webhook como caminho principal e o cron rebaixado a reconciliação.

### Webhook

- ACK em milissegundos, **zero chamada de rede** no handler.
- Grava a notificação e cria uma Cloud Task com **nome derivado do recurso**, de modo que notificações repetidas do mesmo recurso colapsem numa só.
- Superfície pública com autenticação própria e **caminho explicitamente liberado, com teste negativo nas rotas vizinhas**. *Motivo:* na V2, o proxy exigia sessão, o webhook não envia cookie, e as notificações de preço, promoção e Full morriam em silêncio num 307 para `/login` — por semanas, sem ninguém perceber.
- Uma notificação nova enquanto o job do mesmo recurso está em execução deve provocar reprocessamento, não perda da atualização.
- Autenticação de origem: allowlist de IP — ver secao 2.6 e **D-043**.

### Reconciliação

- Janela por cursor, executada por Cloud Scheduler.
- Compara o que existe localmente com a janela remota e enfileira apenas as diferenças.
- Registra em `sync_runs` a distância entre `now()` e o registro mais recente importado — é o dado que alimenta a tela de Saúde da Sincronização.

**Filtro por data confirmado por leitura direta** (`developers.mercadolivre.com.br`, "Gerencie vendas → Orders", 2026-08-21): `GET /orders/search?seller=$SELLER_ID&order.date_last_updated.from=...&order.date_last_updated.to=...`, formato ISO8601 com offset (ex.: `2015-07-01T00:00:00.000-00:00`). Texto oficial, citado literalmente: **"Usa até a hora e descarta a informação dos minutos, segundos e milissegundos."**

Consequência direta para o desenho da janela: qualquer granularidade abaixo de 1 hora é ilusória — o Mercado Livre trunca por conta própria. A V3 nunca envia um `from`/`to` com minutos não-zero: `from` é sempre arredondado **para baixo** até a hora cheia (nunca perder um registro no limite) e `to` sempre **para cima** até a próxima hora cheia (nunca depender de qual direção o Mercado Livre arredonda um valor não documentado). Isso produz alguma sobreposição entre janelas consecutivas — aceitável, porque todo processamento é idempotente por natureza (`docs/API.md` secao 6); o oposto (perder um registro por arredondar errado) não é aceitável.

`order.date_last_updated` (não `date_created`): reconciliação precisa pegar TRANSIÇÕES de status em pedidos já existentes (cancelamento, confirmação de pagamento), não só pedidos novos — é exatamente o que um `date_created` fixo não capturaria.

Checkpoint entre execuções: `latest_record_at` do último `sync_run` bem-sucedido (`resource = 'orders'`, `channel = 'reconciliation'`) para aquela conta — não offset, não estado em memória do worker (regra geral da secao 4). Primeira execução de uma conta usa `ml_accounts.connected_at` como piso.

**Achado durante a implementação (2026-08-21, D-048): `date_last_updated` ≠ `last_updated`.** O exemplo oficial de resposta de `/orders/search` (mesma página, exemplo de busca por `q`) traz os DOIS campos na mesma order, com valores DIFERENTES: `"date_last_updated": "2020-02-14T02:55:49.811Z"` e `"last_updated": "2019-05-28T15:16:04.000-04:00"`. Nenhuma prosa da página explica a diferença — só a descrição do filtro (`order.date_last_updated.from/to: data da última modificação da order`). Decisão: o checkpoint da V3 lê `date_last_updated` (bate o nome com o filtro que a V3 já usa para selecionar a janela; usar o campo errado arriscaria o checkpoint avançar sem cobrir uma mudança real). `last_updated` também é gravado em `orders` (coluna separada), sem ser usado para checkpoint, até a diferença ficar clara. **Pendente de verificação empírica em Dev** — mesma disciplina de D-045.

### Backfill

- Retomável por checkpoint.
- **Fila de prioridade baixa**, para nunca disputar capacidade com o tráfego vivo.
- A auditoria da V2 registrou 17 respostas HTTP 429 em 24 h entre 4 contas **sem backfill em execução**. Backfill competindo com sync ao vivo agrava isso diretamente.

---

## 4. Regras transversais de integração

| Regra | Detalhe |
|---|---|
| **Paginação por cursor** | **Nunca por offset.** A V2 paginava por offset sobre resultado ordenado por data decrescente; pedidos novos durante a varredura deslocavam o offset, e sob pico um pedido podia escapar entre páginas |
| **Rate limit** | Sem número oficial (secao 2.3). Controlado pela fila `ml-sync`, com limite de taxa e concorrência **por conta**, valor conservador ajustado por `429` observado |
| **429 e 5xx** | Backoff exponencial com jitter, honrando `Retry-After` quando presente (não confirmado como padrão do Mercado Livre — implementar defensivamente mesmo assim) |
| **Idempotência** | Toda persistência tem chave natural. O mesmo recurso processado duas vezes produz um efeito |
| **Checkpoint** | Toda varredura longa é retomável |
| **Classificação de erro** | Retryable, retryable com tolerância a consistência eventual, e não retryable. Ver `docs/API.md` |
| **Observabilidade** | `sync_runs`, `sync_errors` e freshness por `(conta, recurso)` |
| **Payload bruto** | Vai para o Cloud Storage, nunca para coluna do Postgres (D-015) |

---

## 5. Fatos sobre os dados do Mercado Livre observados na V2

Observações extraídas do código e da auditoria da V2, **não da documentação oficial**. Devem ser reconfirmadas contra a documentação antes de virarem premissa de implementação.

1. **Não existe pedido multi-linha.** `orders` e `order_items` tinham exatamente 328.211 linhas cada. Uma compra de vários itens vira **vários pedidos** ligados por `pack_id`; 189.158 pedidos tinham um. Consequência: rateio de `total_amount` é um no-op, e `pack_id` é a unidade de compra real do cliente.
2. **Anúncios e variações carregam `inventory_id` e `user_product_id`.** A V2 extraiu ambos do payload e indexou. São os identificadores nativos que amarram anúncio a Full e agrupam variações, poupando trabalho manual de vinculação.
3. **429 acontece na operação normal.** 17 respostas em 24 h entre 4 contas, sem backfill rodando.
4. **Consistência eventual em pedido recém-notificado.** A V2 tratava 404 logo após a notificação como retryable com tolerância.

---

## 6. Contas

A V2 operava **4 contas**, cada uma com credenciais próprias de aplicação. O `.env.example` da V2 listava um par `CLIENT_ID` / `CLIENT_SECRET` por conta.

Na V3, credenciais ficam em `ml_credentials` cifradas, com chave no Secret Manager, e nunca em variável de ambiente por conta. Ver `docs/DEPLOYMENT.md`.

O refresh de token usa lock para evitar corrida entre execuções concorrentes — desenho herdado da V2, que estava correto. **Atenção:** a documentação oficial confirma (secao 2.2) que cada `refresh_token` é de uso único — um refresh concorrente sem lock pode invalidar o token que a outra execução ainda vai tentar usar.

---

## 7. Pendências

- ~~Todo o conteúdo da seção 2. Bloqueia a Fase 3.~~ — **Resolvido em 2026-08-21.** Ver secoes 2.1 a 2.9.
- ~~Confirmação da viabilidade da autorização centralizada pelo ADMIN.~~ — **Confirmada em 2026-08-21** (secao 2.2): viável, com autorização feita conta por conta pelo ADMIN; usuários internos não reautenticam depois. Ver **D-041**.
- **Endpoints de visitas e de Ads** — necessários apenas na Fase 5B (D-032). Ainda não pesquisados; não bloqueia a Fase 3.

### Avisos operacionais encontrados na pesquisa, não bloqueantes hoje

- A partir de **30/08/2026** o Mercado Livre exige aplicações separadas entre Mercado Livre e Mercado Pago (uma aplicação por unidade de negócio) — relevante se a V3 vier a usar a API do Mercado Pago para conciliação financeira.
- A "vista atual" de `GET /orders/{order_id}/shipments` (retorna objeto único) será **descontinuada no fim de setembro/2026**, substituída pela "Hosted View" que **sempre** retorna array — desenhar o parser do worker já para o formato novo, não para o legado.
- Header `X-Api-Version: 2` é necessário em `/orders/{order_id}/shipments` para obter PII completo do destinatário (`receiver_name`, `receiver_phone`).
