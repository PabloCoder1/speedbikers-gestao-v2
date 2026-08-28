# Integração Mercado Livre — Speed Bikers Gestão V3

> Dono documental de: estratégia de sincronização, regras de integração e registro de endpoints.
> Status: **estratégia aprovada. Lista de verificação da secao 1 confirmada por completo — Perguntas/Mensagens pesquisadas em 2026-08-25 (secao 2.12, D-083), visitas em 2026-08-23 (secao 2.11), Ads pesquisado mas ADIADO (D-059).**

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
- [x] Endpoints de visitas — secao 2.11 (D-032, implementado 2026-08-23). Ads pesquisado (mesma seção), mas ADIADO por D-059 — exige `advertiser_id` com elegibilidade própria, sem evidência de a conta ter o produto habilitado
- [x] Escopos de OAuth necessários por recurso — secao 2.9
- [x] Política de validação de origem do webhook — secao 2.6 (allowlist de IP; **sem assinatura HMAC documentada** para este produto)
- [x] Endpoints de pós-venda (Claims/Returns) — secao 2.10 (D-057)
- [x] Endpoints de Perguntas e Mensagens pós-venda (Central de Atendimento/SAC, Fase 7B) — secao 2.12, pesquisa oficial concluída em 2026-08-25 (D-083)
- [x] Valores de `status` do item e ciclo de vida da publicação — secao 2.13 (2026-08-24, pré-requisito crítico da Fase 7 — `listing.status.paused`/`.reactivated`)

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
| Perguntas recebidas pela conta | `GET /my/received_questions/search?api_version=4` | Comunicação pré e pós-venda | `offset`/`limit`, padrão 50; `scan` não confirmado para esta variante | secao 2.12 | 2026-08-25 |
| Busca/detalhe de pergunta | `GET /questions/search?seller_id=...&api_version=4`; `GET /questions/{question_id}?api_version=4` | Comunicação pré e pós-venda | busca por `offset`/`limit`; `search_type=scan` acima de 1000, scroll de 5 min; detalhe sem paginação | secao 2.12 | 2026-08-25 |
| Responder pergunta | `POST /answers` | Comunicação pré e pós-venda, escrita | — | secao 2.12 | 2026-08-25 |
| Tempo médio de resposta a perguntas | `GET /users/{user_id}/questions/response_time` | Comunicação pré e pós-venda | — | secao 2.12 | 2026-08-25 |
| Mensagens de um pack/pedido | `GET /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale&mark_as_read=false` | Comunicação pré e pós-venda | `offset`/`limit` | **500 rpm compartilhados entre GETs** | 2026-08-25 |
| Detalhe de mensagem | `GET /messages/{message_id}?tag=post_sale` | Comunicação pré e pós-venda | — | **500 rpm compartilhados entre GETs** | 2026-08-25 |
| Enviar mensagem pós-venda | `POST /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale` | Comunicação pré e pós-venda, escrita | uma mensagem por chamada | **500 rpm compartilhados entre POST/PUT** | 2026-08-25 |
| Conversas não lidas | `GET /messages/unread?role=seller&tag=post_sale`; `GET /messages/unread/{resource}?tag=post_sale` | Comunicação pré e pós-venda | até **500 conversas por chamada** | **500 rpm compartilhados entre GETs** | 2026-08-25 |
| Anexo de mensagem | `POST /messages/attachments?tag=post_sale&site_id=MLB`; `GET /messages/attachments/{attachment_id}?tag=post_sale&site_id=MLB` | Comunicação pré e pós-venda | — | pool de leitura ou escrita conforme método | 2026-08-25 |
| Detalhe de claim | `GET /post-purchase/v1/claims/{claim_id}` | `read`, "Vendas e envios" ou "Comunicação pré e pós-venda" | — | secao 2.3 | 2026-08-23 |
| Detalhe de devolução | `GET /post-purchase/v2/claims/{claim_id}/returns` | `read`, mesma acima | — | secao 2.3 | 2026-08-23 |
| Detalhe/SLA do claim | `GET /post-purchase/v1/claims/{claim_id}/detail` | Comunicação pré e pós-venda | — | secao 2.3 | 2026-08-25 |
| Mensagens do claim | `GET /post-purchase/v1/claims/{claim_id}/messages` | Comunicação pré e pós-venda | — | secao 2.3 | 2026-08-25 |
| Responder mensagem do claim | `POST /post-purchase/v1/claims/{claim_id}/actions/send-message` | Comunicação pré e pós-venda, ação disponível ao player | — | secao 2.3 | 2026-08-25 |
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
| Comunicação pré e pós-venda | `questions`, `messages`, `claims`, `returns` | `claims`/`returns` já usados (D-057); `questions`/`messages` confirmados para a Fase 7B (D-083), ainda sem implementação |
| Métricas do negócio | `trends`, `highlights`, `visits` | `visits` em uso desde 2026-08-23 (secao 2.11); `trends`/`highlights` seguem sem uso |
| Publicidade | Advertising | ADIADO (D-059) — exige `advertiser_id` com elegibilidade própria, sem evidência de a conta ter o produto habilitado |
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

**RE-LEITURA AO VIVO EM 2026-08-27 (D-104), antes da ingestão de SAC** — o registro acima listava só "os campos que a V3 usa hoje", o que bastava para estoque mas não para projetar o claim na Caixa de Entrada. Campos adicionais confirmados no exemplo oficial de `GET /post-purchase/v1/claims/{claim_id}`:

| Campo | Valores/forma | Uso na V3 |
|---|---|---|
| `date_created` / `last_updated` | ISO com offset (`"2024-03-21T05:19:22.000-04:00"`) | `last_activity_at` sai daqui — **nunca** do relógio da V3 (lição de D-097) |
| `stage` | `claim` \| `dispute` \| `recontact` \| `none` \| `stale` | **`dispute` é a mediação** (ver aviso abaixo) |
| `resolution` | `{reason, date_created, closed_by, benefited, applied_coverage}` | `resolved_at` sai de `resolution.date_created` |
| `players[]` | `{role, type, user_id, available_actions[]}` | comprador (`type = "buyer"`) e estado de resposta |
| `players[].available_actions[]` | `{action, mandatory, due_date}` | `send_message_to_*` define `remote_reply_state`; `due_date` é fonte de prazo |
| `parent_id`, `reason_id`, `fulfilled`, `quantity_type`, `claimed_quantity`, `claim_version`, `site_id` | — | ainda não consumidos |

> ⚠️ **`type = "mediations"` NÃO é mediação.** A mesma página define `type: "mediations"` como a reclamação comum "entre comprador e vendedor", e `stage: "dispute"` como a "etapa de mediação onde intervém um representante do Mercado Livre". O exemplo oficial traz `type: "mediations"` com `stage: "claim"`, encerrado pelo vendedor. Confundir os dois marca reclamação comum como mediação crítica — ver D-104.

**Nota de robustez (D-101):** `date_created`/`last_updated`/`stage`/`players`/`resolution` entraram no schema da V3 como **opcionais**. Campo presente no exemplo da doc pode faltar no payload real, e o mesmo schema é usado pela reversão de estoque que já roda em produção — exigi-los transformaria uma ausência em ZodError que derrubaria dado financeiro.

**Fonte:** `developers.mercadolivre.com.br/pt_br/gerenciar-reclamacoes`, `.../gerenciar-devolucoes`, `.../produto-receba-notificacoes`.

---

## 2.11 Visitas — CONFIRMADO (leitura ao vivo, 2026-08-23); Ads — pesquisado, ADIADO (D-059)

**Visitas por anúncio, em janela de dias**: `GET /items/{item_id}/visits/time_window?last=$LAST&unit=day&ending=$ENDING` — devolve `results: [{date, total, visits_detail}]`, um total por dia. `date` chega como datetime ISO completo (`"2021-08-04T00:00:00Z"`), convertido para `YYYY-MM-DD` por corte de string (`entry.date.slice(0, 10)`), nunca `new Date(...)` — mesmo raciocínio de `formatBusinessDate`. Sem `ending`, a amostra termina na data/hora atual. Máximo de janela: **150 dias** entre `date_from`/`date_to` nas variantes que usam essas datas; `time_window` não documenta um teto explícito para `last`, mas a V3 usa `last=3` (bem abaixo de qualquer limite plausível).

Existe também uma variante por CONTA inteira (`GET /users/{user_id}/items_visits/time_window`, sem quebra por item) — não usada: a V3 precisa do detalhe por anúncio para cruzar com `daily_listing_metrics` e calcular conversão por item, não só o total da conta.

**Fonte:** `developers.mercadolivre.com.br/pt_br/recurso-visits`.

**Product Ads (Mercado Ads) — pesquisado, mas ADIADO por D-059**: a API exige um `advertiser_id` PRÓPRIO por conta e por tipo de produto (`PADS`/`DISPLAY`/`BADS`, consultado via `GET /advertising/advertisers?product_id=...`), com elegibilidade condicionada (reputação amarela+, 15+ dias de conta, mínimo de vendas, sem fatura vencida — erro `404 No permissions found` quando o usuário não tem o produto habilitado). Cadeia de consulta: `advertisers` → `campaigns` → `ads` → `metrics`, quatro recursos hierárquicos com um header `api-version` próprio — integração do tamanho de Claims/Returns ou listings, não um adendo a Visitas. **Nota de manutenção da própria doc**: os endpoints legados de Product Ads (`/advertising/product_ads/...`) foram desativados em 26/02/2026 — se algum dia isso for retomado, usar SÓ os endpoints atuais (`/advertising/{site}/product_ads/...`), nunca os legados citados como descontinuados.

**Fonte:** `developers.mercadolivre.com.br/pt_br/product-ads-leitura`.

---

## 2.12 Perguntas e Mensagens pós-venda — CONFIRMADO (leitura oficial, 2026-08-25, D-083)

Pesquisa feita exclusivamente na documentação oficial vigente. A permissão funcional **Comunicação pré e pós-venda** permite ler e enviar comunicação pré/pós-compra e libera acesso aos recursos `questions`, `messages`, `claims` e `returns`. As ações efetivamente disponíveis continuam sendo definidas por cada recurso e, em claims, por `players[].available_actions`. Isso confirma a viabilidade técnica da Fase 7B com as mesmas credenciais por conta já usadas pela V3; não cria autorização autônoma para responder — a confirmação humana de D-071 continua obrigatória.

### Perguntas pré-venda (`questions`)

- **Reconciliação da conta autenticada:** `GET /my/received_questions/search?api_version=4`. A busca alternativa `GET /questions/search?seller_id={seller_id}&api_version=4` permite filtrar por vendedor; há também busca por item e detalhe `GET /questions/{question_id}?api_version=4`.
- **Payload relevante:** `id`, `seller_id`, `item_id`, `status`, `text`, `date_created`, `last_updated`, `deleted_from_listing`, `suspected_spam`, `hold`, comprador em `from.id`/`buyer_id` e `answer` (`text`, `status`, `date_created`). Texto de pergunta/resposta com status `BANNED` chega vazio — a V3 não deve interpretar vazio como ausência de conteúdo original.
- **Estados documentados:** `ANSWERED`, `BANNED`, `CLOSED_UNANSWERED`, `DELETED`, `DISABLED`, `UNANSWERED`, `UNDER_REVIEW`.
- **Resposta:** `POST /answers`, JSON `{ "question_id": number, "text": string }`. Pergunta e resposta aceitam no máximo **2.000 caracteres**; a documentação pede UTF-8.
- **Paginação:** padrão 50. Em `/questions/search`, para mais de 1.000 registros, usar `search_type=scan`, atualizando o `scroll_id` a cada chamada; o scroll expira em 5 minutos. A documentação geral de busca registra limite máximo de 100 por página. Esse modo não foi explicitamente confirmado para `/my/received_questions/search`; não presumir equivalência na implementação.
- **Filtros e ordenação de `/my/received_questions/search` — CONFIRMADO por leitura oficial em 2026-08-25 (D-089), lendo o payload de exemplo da própria página:**
  - a resposta declara `available_filters` = `item`, `from`, `totalDivisions`, `division` e **`status`** (com exatamente os sete valores acima). **Não existe filtro por data neste endpoint** — nem `date_created.from/to`, nem equivalente. Consequência direta: reconciliação "dos últimos N dias" é impossível de expressar aqui;
  - `available_sorts` = `item_id`, `from_id`, `date_created`, `seller_id` — mas a resposta padrão traz `"sorts": []`, ou seja, **a ordenação default não é documentada**. Nenhuma lógica pode depender de "as mais recentes vêm primeiro";
  - a resposta traz `total`, `limit` e `questions[]` no topo; **`offset` vive dentro de `filters`, não no topo**;
  - cada entrada de `questions[]` tem o MESMO formato do detalhe (`id`, `seller_id`, `item_id`, `status`, `text`, `date_created`, `deleted_from_listing`, `hold`, `answer`, `from.id`) — um único contrato serve aos dois, que é como `receivedQuestionSchema` foi escrito em D-086. `suspected_spam` não aparece no exemplo da busca, então o contrato o trata como opcional com default `false`;
  - `search_type=scan` continua sem aparecer documentado para este endpoint.
- **Webhook:** tópico geral `questions`, disparado para perguntas **e respostas**, com `resource: "/questions/{question_id}"`; o worker deve buscar o detalhe pelo `resource`. Não tem array `actions`.
- **SLA:** não há `due_date` por pergunta documentado. Existe `GET /users/{user_id}/questions/response_time`, métrica agregada dos últimos 14 dias por faixas de horário, atualizada uma vez por dia, incluindo projeção de aumento de vendas quando a resposta excede 60 minutos. Isso serve como métrica; qualquer prazo operacional por pergunta da V3 será regra interna, não campo remoto. Perguntas sem resposta há mais de 7 meses são removidas automaticamente.

### Mensagens pós-venda (`messages`)

- **Leitura de uma conversa:** `GET /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale&mark_as_read=false&limit=&offset=`. Se `pack_id` for nulo, usar o `order_id` no mesmo segmento `/packs`. `mark_as_read=false` é obrigatório na ingestão: sem ele, esse GET marca as mensagens como lidas no Mercado Livre.
- **Payload EXATO — CONFIRMADO por leitura ao vivo em 2026-08-26**, lendo o JSON de exemplo das duas páginas oficiais. A descrição em prosa que estava aqui não bastava para escrever um schema; os nomes reais são:
  - `paging` (`limit`, `offset`, `total`);
  - `conversation_status` (`path`, `status`, `substatus`, `status_date`, **`status_update_allowed`**, `claim_id`, `shipping_id`) — o campo `status_update_allowed` não estava registrado;
  - `messages[]`: `id` (**não `message_id`** nesta forma), `site_id`, `client_id`, `from.user_id`, `to.user_id`, `status`, `subject`, `text`, **`message_date` (objeto aninhado: `received`/`available`/`notified`/`created`/`read`)**, **`message_moderation`** (`status`, `reason`, `source`, `moderation_date`), `message_attachments`, `message_resources[]` (`id`, `name`) e `conversation_first_message`. As datas **não** são campos planos `date_*` nesta resposta;
  - `seller_max_message_length` (350) e **`buyer_max_message_length`** (3500), este último também ausente do registro anterior.
- **⚠️ As duas páginas oficiais DISCORDAM entre si sobre a MESMA resposta.** Comparando "Gestão de mensagens pós-venda" (27/04/2026) com "Mensagens pendentes" (30/12/2025):

  | campo | "Gestão de mensagens" | "Mensagens pendentes" |
  |---|---|---|
  | `from.user_id` | número `123456789000` | **string** `"415458330"` |
  | `status` | `"available"` (minúsculas) | `"IN_MODERATION"` (maiúsculas) |
  | `message_moderation.status` | `"clean"` | `"NON_MODERATED"` |
  | `message_moderation.reason` | `null` | `"none"` |
  | origem da moderação | `source` | `by` |
  | `to` | presente | **ausente** |
  | `message_resources[].name` | `"sellers"` | `"seller"` |

  Consequência para a V3: o contrato é **estrito na ESTRUTURA e permissivo nos VALORES** — nada de enum fechado para `status`/moderação, comparação normalizada por caixa, e `user_id` aceito como número ou string numérica. Um enum fechado transformaria variação cosmética do Mercado Livre em perda de atendimento.
- **PII no payload:** `from` traz `email` e `name` do comprador no exemplo de "Mensagens pendentes". O contrato declara só `user_id`, então o `.parse()` descarta os dois — dado pessoal de comprador não entra no processo.
- **Moderação é assimétrica:** mensagem moderada do COMPRADOR não aparece na listagem; a do VENDEDOR aparece mesmo moderada.
- **`GET /messages/{message_id}` tem DUAS respostas documentadas na mesma página** — "sem header" (objeto plano: `message_id`, `date_received`/`date`/`date_available`/`date_notified`/`date_read`, `text.plain`, `moderation`, `resource`, `resource_id`) e "atualizada (com header)" (o MESMO envelope da conversa). **A documentação não diz qual header seleciona qual formato**, então a V3 aceita os dois.
- **Detalhe:** `GET /messages/{message_id}?tag=post_sale`.
- **Resposta:** `POST /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale`, JSON com `from.user_id`, `to.user_id`, `text` e `attachments` quando houver. Limite do vendedor: **350 caracteres** e uma mensagem por chamada.
- **Arquitetura vigente no MLB desde 02/02/2026:** quando a conversa passa pelo Agente de Mensageria, `to.user_id` no POST e `from.user_id` no GET representam o agente, não o comprador real. O ID documentado para MLB é `3037675074`. A associação ao pedido/pack e à conta, não o `user_id` remoto isolado, deve governar identidade e autorização na V3.
- **Início de conversa:** a resposta livre normal pressupõe conversa iniciada pelo comprador. Contato iniciado pelo vendedor usa o fluxo separado de motivos permitidos (`GET /messages/action_guide/packs/{pack_id}` e opções/capacidade disponíveis), nunca um POST livre inventado pela V3.
- **Não lidas/reconciliação:** `GET /messages/unread?role=seller&tag=post_sale`. **Payload exato confirmado em 2026-08-26:** `{ "user_id": 378136913, "results": [{ "resource": "/packs/1977056109/sellers/378136913", "count": 1 }] }`; sem pendências, `results` vem `[]` — e no exemplo vazio `user_id` aparece como **string**. Até **500 conversas por chamada**. `role` é obrigatório e **não tem valor padrão**: omiti-lo não devolve erro, devolve resultado errado. A própria documentação o recomenda como redundância para perdas do webhook. Existe forma filtrada `GET /messages/unread/{resource}?tag=post_sale`.
- **A página "Mensagens pendentes" apresenta o GET da conversa SEM `mark_as_read=false` como A FORMA DE MARCAR COMO LIDA.** É a confirmação mais direta de por que D-083 decisão 2 existe: o parâmetro não é otimização, é o que separa ler de alterar o estado operacional do vendedor.
- **Webhook:** tópico tipificado `messages`, `resource` é o ID da mensagem (sem barra de path) e `actions` vale `created` ou `read`; buscar com `GET /messages/{resource}`. O tópico está documentado para Argentina, Brasil e México.
- **Rate limit específico:** GETs de mensageria compartilham um pool de **500 rpm**; POST/PUT compartilham outro pool de **500 rpm**. Continua obrigatório tratar 429 com backoff/jitter.
- **Bloqueios/prazo:** no fluxo intermediado por agente, o vendedor tem **48 horas úteis** para resolver antes de a conversa ser bloqueada. Ordens canceladas bloqueiam a mensageria; mediação em andamento também pode bloquear o endpoint pós-venda comum. A V3 deve persistir `conversation_status` e nunca prometer envio só porque o caso está aberto localmente.
- **Anexos:** upload por `POST /messages/attachments?tag=post_sale&site_id=MLB`, depois o ID entra em `attachments`; máximo **25 MB**, formatos JPG/PNG/PDF/TXT, até 25 anexos conforme a tabela de erros. Anexo órfão expira em 48 horas; nome original tem limite de 200 caracteres.

### Claims, devoluções e mediações

- `type: "mediations"` é um tipo/estado do próprio **claim**, não um recurso raiz separado. O detalhe continua em `GET /post-purchase/v1/claims/{claim_id}`; `stage` e `players[].available_actions` dizem o que cada participante pode fazer.
- `GET /post-purchase/v1/claims/{claim_id}/detail` expõe `due_date`, `action_responsible`, título, descrição e problema. `players[].available_actions[].due_date` é outra fonte de prazo por ação. Para claims, a V3 deve usar o prazo remoto quando presente, não inventar um SLA concorrente.
- Mensagens do claim: `GET /post-purchase/v1/claims/{claim_id}/messages`. Resposta: `POST /post-purchase/v1/claims/{claim_id}/actions/send-message`, com `receiver_role` (`complainant`, `mediator` ou `respondent`), `message` e anexos opcionais. O envio só é válido quando a ação correspondente aparece em `available_actions`; status de sucesso documentado: 201.

#### Contrato do transcript — CONFIRMADO (leitura ao vivo, 2026-08-27)

A resposta é um **ARRAY NU**, não um envelope com `results`/`paging` — diferente de todo o resto da integração. Nenhum parâmetro de paginação é documentado.

| Campo | Forma | Observação |
|---|---|---|
| `sender_role` / `receiver_role` | `complainant` \| `respondent` \| `mediator` | quem falou e para quem |
| `message` | texto | |
| `translated_message` | nullable | só em CBT |
| `date_created` / `last_updated` / `message_date` | ISO com offset | |
| `date_read` | nullable | |
| `attachments[]` | `{filename, original_filename, size, date_created, type}` | JPG/PNG/PDF, até 5 MB |
| `status` | `available` \| `moderated` \| `rejected` \| `pending_translation` | |
| `stage` | `claim` \| `dispute` | mesma semântica de `claims.stage` |
| `message_moderation` | `{status: clean\|rejected\|pending\|non_moderated, reason, source, date_moderated}` | `reason` observado como `""` E como `null` |
| `repeated` | boolean | |

> 🔴 **Não existe `id` de mensagem no payload.** É exatamente o caso que D-084 previu ao escrever "se o payload oficial não trouxer ID estável, a implementação deve confirmar a forma real e usar fingerprint determinístico documentado — **nunca índice do array**". A confirmação agora está feita: o ID não existe, então o `external_message_key` de mensagem de claim TERÁ de ser fingerprint. Índice de array quebraria na primeira mensagem moderada/filtrada, que desloca todas as seguintes.

> ⚠️ **O transcript pode ser incompleto e não há como saber.** A doc é explícita: "apenas as mensagens PRÓPRIAS que foram moderadas serão exibidas; as mensagens da contraparte que também passaram por moderação serão automaticamente filtradas". Ou seja, mensagem moderada do comprador some da resposta sem deixar buraco visível — diferente de `BANNED` em Perguntas (D-086), onde a mensagem existe com corpo vazio. Qualquer contagem de mensagens do claim é um piso, nunca um total; a UI não deve afirmar "N mensagens" como fato.

**Fonte:** `developers.mercadolivre.com.br/pt_br/gerenciar-mensagem-de-uma-eclamacao` (o slug tem o typo "eclamacao" no próprio site — a URL com "reclamacao" redireciona para a home).
- O webhook permanece `post_purchase`, com `actions: ["claims"]` ou `["claims_actions"]` e `resource` apontando para `/post-purchase/v1/claims/{claim_id}`.

### Consequência para a Fase 7B

O primeiro corte continua **read-only**: webhook como caminho principal, reconciliação para perguntas e mensagens não lidas, persistência idempotente e UI sem envio. D-084 fechou o mapeamento local: case por pergunta, conversa por pack/pedido ou claim; mediação e devolução são facetas do claim, e mensagens do claim ficam no transcript desse claim. Identidade usa conta + recurso/chave remota, nunca `from/to`.

A escrita entra depois, por comando privilegiado da `apps/api`, com confirmação humana, validação de permissão da conta, refresh do estado remoto e `available_actions` quando aplicável. A pesquisa D-083 e o modelo D-084 não criaram integração; D-085 criou o núcleo local de banco. D-086 implementou o contrato v4, fixtures documentadas, mapper puro e persistência idempotente somente de Perguntas: `BANNED` preserva a existência da mensagem sem expor texto, `UNDER_REVIEW` vira conteúdo moderado e uma resposta já existente materializa a mensagem outbound. Essa porta ainda não chama o Mercado Livre, não está registrada em job/router e não recebe webhook.

Detalhe `GET /questions/{question_id}?api_version=4` e handler
`sync.support.questions` para um `questionId` implementados em D-087,
reutilizando o mecanismo vigente de token/retry. **O produtor entrou em D-088**:
o ACK do webhook (`apps/api/src/webhook.ts`) reconhece `topic=questions`,
extrai o ID de `/questions/{question_id}` e enfileira o job na fila da conta.
Como o tópico dispara para pergunta E resposta com o mesmo `resource`, e o
detalhe traz as duas, o dedupe por recurso + janela de minuto faz as duas
notificações colapsarem numa busca só.

**Reconciliação implementada em D-089**, fechando a lacuna acima:
`sync.support.questions.reconcile` varre `GET /my/received_questions/search`
por conta, a cada 6h, e persiste pela mesma porta idempotente de D-086.

**O recorte é `status=UNANSWERED`, e o motivo é a própria API.** Sem filtro por
data e sem ordenação garantida (ver a lista de filtros/sorts confirmados
acima), "reconciliar a última janela" não é expressável — a alternativa seria
varrer o histórico inteiro da conta a cada rodada. `status` é filtro oficial, e
pergunta não respondida é exatamente o caso operacional que importa: alguém
esperando resposta que a V3 nunca viu. O conjunto ainda é limitado pelo próprio
Mercado Livre, que remove perguntas sem resposta há mais de 7 meses.

**Lacuna conhecida, registrada e não escondida:** uma pergunta que o webhook
perdeu E que alguém respondeu pelo app do Mercado Livre não é recuperada — ela
não está mais `UNANSWERED`. É buraco de histórico, não de operação; fechá-lo
exigiria varrer os sete status a cada rodada, custo que só se justifica com
evidência real de que acontece.

Nenhum envio de resposta foi implementado.

**Fontes oficiais consultadas:** `developers.mercadolivre.com.br/pt_br/perguntas-e-respostas`; `.../itens-e-buscas`; `.../pt_br/mensagens-post-venda`; `.../pt_br/mensagens-pendentes`; `.../pt_br/motivos-para-se-comunicar`; `.../pt_br/mensagens-post-venda/produto-receba-notificacoes`; `.../pt_br/permissoes-funcionais/`; `.../pt_br/gerenciar-reclamacoes`; `.../pt_br/gerenciar-mensagem-de-uma-eclamacao`.

---

## 2.13 Status e ciclo de vida do item — CONFIRMADO (leitura ao vivo, 2026-08-24)

Pesquisado para implementar `listing.status.paused`/`listing.status.reactivated` (`docs/HANDOFF.md`, "Pré-requisito crítico da Fase 7") — o catálogo de eventos já tinha essas duas linhas desde a Fase 0, mas os valores reais de `status` nunca tinham sido confirmados (`listing-schema.ts` só validava `status: z.string()`, sem enum).

**Valores de topo do campo `status`** (case-sensitive, sempre minúsculo ao ENVIAR — a V3 só LÊ hoje):

- `active` — anúncio ativo, visível.
- `paused` — pausado, com dois motivos distintos (sem substatus próprio hoje em `listings`, ver achado abaixo): `out_of_stock` (automático, `available_quantity` chegou a 0) e `paused_by_seller` (decisão do vendedor).
- `under_review` — em revisão (`warning`, `waiting_for_patch`, `held`, `pending_documentation`, `forbidden`).
- `closed` — status final (`waiting_for_patch`, `held`, `expired`, `deleted`, `suspended`, `freezed`).
- `payment_required` — vendedor com dívida/baixa política de crédito; reativa sozinho após o pagamento.
- `inactive` — correção de `under_review` não feita a tempo.

**Achado crítico — `available_quantity` e `status` NÃO são independentes:** "Ao fazer o PUT do `available_quantity = 0`, mudará o estado para 'paused' com subestado `out_of_stock`. Ao fazer o PUT do `available_quantity` superior a 0 e o subestado sendo `out_of_stock`, mudará o estado para ativo sem subestado `out_of_stock`." — citação literal da página. Ou seja: estoque zerar PAUSA o anúncio sozinho, e repor estoque REATIVA sozinho (só quando o motivo da pausa era `out_of_stock` — pausa manual do vendedor, `paused_by_seller`, **não** reativa sozinha ao repor estoque). Consequência para o motor de diff: `listing.available_quantity.changed` e `listing.status.paused`/`.reactivated` podem disparar juntos para a MESMA causa raiz — não é duplicidade, são duas perguntas diferentes respondidas ("quanto mudou" e "o anúncio saiu do ar"), mesmo padrão já aceito em `stock.depleted` + `listing.fulfillment.entered` (`packages/domain/src/events/fulfillment-events.ts`).

**Achado, sem virar migration agora:** `listings.status` (`docs/DATABASE.md`) grava só o status de TOPO, sem o substatus (`out_of_stock` vs `paused_by_seller`) — a V3 hoje não distingue as duas causas de pausa. Fica registrado como limitação conhecida; capturar substatus exigiria estender `listingItemSchema`/a migration de `listings`, fora do escopo de implementar o motor de diff com o dado já coletado.

**Fonte:** `developers.mercadolivre.com.br/pt_br/produto-sincronizacao-de-publicacoes` ("Sincronização e modificação de publicações", última atualização 24/03/2026).

---

## 2.14 Catálogo completo do vendedor — CONFIRMADO (leitura ao vivo, 2026-08-28, D-120/D-121)

**Nota de método:** o portal devolve **403** para fetcher automatizado; as páginas foram lidas via `curl` com User-Agent de navegador. O espelho EN devolve só um shell JS — PT e ES renderizam no servidor e foram lidos integralmente.

**Por que isto importa:** `GET /users/{user_id}/items/search` está registrado na seção 2 desde a Fase 0 e **nunca foi chamado**. `listings` é populada enumerando `sku_listing_links` — ou seja, a V3 **não sabe quais anúncios existem**, só quais já foram vinculados pela planilha do UpSeller. Medido em 2026-08-28: **7.361 itens já venderam** (prova de existência), **3.679 sem vínculo nenhum**, e 21,8% dos itens vendidos em 30 dias saem com `sku_id` nulo (R$ 699.733,15).

### O contrato

```
GET https://api.mercadolibre.com/users/{user_id}/items/search
```

Resposta: `{ seller_id, query, paging{limit,offset,total}, results, orders, available_orders }`.

**`results` é lista de IDs (strings), NUNCA de objetos.** Enumerar o catálogo é obrigatoriamente um processo de **duas fases**: descobrir IDs, depois hidratar.

`filters`/`available_filters` não vêm por padrão (*"para melhorar os tempos de resposta"*); exigem `include_filters=true`.

### Paginação e o teto de 1.000

| Item | Situação |
|---|---|
| `limit` default 50, **máximo 100** | CONFIRMADO (o ES desambigua o PT) |
| `offset` máximo | **NÃO DOCUMENTADO** — o parâmetro nunca aparece em prosa nem em exemplo desta página |
| **Teto de 1.000 resultados** | **CONFIRMADO que existe**, em três lugares independentes da doc |

A doc afirma o teto e manda usar `scan` para passar dele — mas **nunca descreve o que acontece ao ultrapassar 1.000 com `offset`** (erro? truncamento silencioso?). Não inferir.

**Consequência direta para a V3:** a maior conta já teve **2.675 itens distintos observados**. `scan` não é otimização, é **obrigatório**.

### `search_type=scan`

```
GET /users/{id}/items/search?search_type=scan            # 1ª chamada
GET /users/{id}/items/search?search_type=scan&scroll_id=<mesmo id>   # seguintes
```

- O `scroll_id` **expira em 5 minutos** e deve ser o MESMO em todas as chamadas.
- No fim da lista o retorno é `null` — **a doc não diz qual campo** vira null.
- *"remova o deslocamento"* (`offset`).

⚠️ **Contradição entre duas páginas oficiais, registrada e não resolvida por inferência:** a FAQ de rate limit (05/05/2026) diz que usar `scroll_id` junto com `offset`/`limit` **causa erro**; a página de itens (07/04/2025) coloca a nota do `limit` máximo 100 dentro da seção do scan. A FAQ é mais recente. **Plano conservador: `limit` só na primeira chamada; chamadas com `scroll_id` não levam `limit` nem `offset`** — e isso precisa ser MEDIDO.

**O scan não pode ser paralelizado nem pausado.** A FAQ é explícita: *"O scroll expira e o consumo repetido ou deixado aberto por muito tempo gera 429."* Pausar o laço para gravar em lote no banco é o caminho para 429 + scroll expirado.

### Filtros

Documentados com prosa e exemplo: `status`, `sku` (seller_custom_field), `seller_sku`, `listing_type_id`, `missing_product_identifiers`, `reputation_health_gauge` (disponível no Brasil), `include_filters`.

Valores de `status` do FILTRO: `pending`, `not_yet_active`, `programmed`, `active`, `paused`, `closed`.

⚠️ **Divergência com a seção 2.13 deste documento:** `under_review` é status de topo do ITEM, mas **não consta entre os valores deste filtro**. Existe um filtro separado `sub_status` (`deleted`, `forbidden`, `freezed`, `held`, `suspended`, `waiting_for_patch`, `warning`). Não assumir `?status=under_review`.

🔴 **NÃO EXISTE filtro por data.** `last_updated_*`, `start_time_*` e `stop_time_*` aparecem **exclusivamente como IDs de ordenação**. Isto **mata sincronização incremental por este endpoint** — o incremental tem de vir do webhook `items`, e `items/search` fica para reconciliação/backfill completo. A própria doc posiciona assim: *"O uso de nosso recurso de busca de itens de um seller **não substitui o uso das notificações de itens**."*

**`q` (busca textual) não tem nome documentado.** A resposta traz `"query": null` e `/restrictions` devolve `query_allowed: true` — existe algum parâmetro, mas o nome nunca é escrito. Não inventar `q=`.

### Ordenação — a armadilha do D-109 de novo

**O parâmetro é `orders`, NÃO `sort`.** `sort` pertence ao outro endpoint (`/sites/{site_id}/search`). Trocar os dois é exatamente o erro que custou D-109.

IDs documentados: `stop_time_asc|desc`, `start_time_asc|desc`, `available_quantity_asc|desc`, `price_asc|desc`, `last_updated_asc|desc`. Padrão aplicado pelo site: `stop_time_asc`.

Defeito da própria doc: existe uma 11ª entrada de `available_orders` cujo `id` **é um objeto, não string** (`inventory_id_asc`). Não assumir que é utilizável.

**Conta grande:** `GET /users/{id}/items/search/restrictions` → `aggregations_allowed` vira `false` acima de **200.000 itens** (nosso caso está muito abaixo).

### Multiget — a segunda fase

```
GET /items?ids=A,B,C&attributes=id,title,status,price,...
```

- **Máximo de 20 ids por chamada.**
- Resposta em formato **verbose**: array de `{ code, body }` — **cada item traz o próprio código**, então falha é por item, não da chamada.
- `attributes=` projeta campos.

⚠️ **`include_attributes=all` é do item singular, não está documentado no multiget.** E ele é **crítico para vinculação**: *"No caso que deseje consultar o seller custom field deverá enviar o parâmetro `include_attributes=all`"* — ou seja, o `seller_custom_field` (nossa melhor pista de SKU) pode não vir sem ele. Combinar os dois é inferência; medir.

### Variações

A busca **não devolve variações** — só `item_id`. As duas formas documentadas são `GET /items/{id}?attributes=variations` e `GET /items/{id}/variations`.

### Escopos

Nenhum escopo é nomeado por endpoint; `read` + `offline_access` bastam, e a permissão funcional "Publicação e sincronização" **já está habilitada** (a V3 já consome `GET /items/{id}`). **O motivo de 3.679 anúncios estarem invisíveis não é permissão — é que a chamada nunca foi feita.**

### Sem deprecação

A tabela oficial de migração **deprecia o outro endpoint em favor deste**: `/sites/{site}/search?seller_id=` → *"Substitua por `/users/{User_id}/items/search`"*. Para `items/search`, `?search_type=scan` e `/items?ids=`, a coluna diz **"Se mantém"**. Busca por `deprec`/`descontinu`/`obsolet` nas versões PT e ES: zero ocorrências.

### A MEDIR antes de confiar (a doc não responde)

1. `items/search` sem `status` devolve `closed`/`paused` ou só ativos? A frase "os resultados sempre serão de itens ativos" pertence a **outro endpoint** na mesma página.
2. `limit` junto com `scroll_id` funciona ou erra? (a contradição acima)
3. `orders`/`status`/`sku` são compatíveis com `scan`?
4. Qual campo vira `null` no fim do scan?
5. `include_attributes=all` funciona no multiget?

---

## 2.15 Dados financeiros do pedido — CONFIRMADO (leitura oficial, 2026-08-28, D-120)

Pesquisado para decidir se "receita líquida" é exibível. **Resposta: parcialmente, e não com esse nome.**

**O que é contrato:**

| Campo | Onde | O que é |
|---|---|---|
| `order_items[].sale_fee` | `GET /orders/{id}` | "comissão de vendas"; em Provisões, "tarifa por unidade" |
| `payments[].marketplace_fee` | `GET /orders/{id}` | "tarifa totalizada no pedido" |
| `senders[].cost` | `GET /shipments/{id}/costs` | custo do frete cobrado DO VENDEDOR — a FAQ oficial designa este campo para conciliação |
| `amounts.seller` | `GET /orders/{id}/discounts` | parcela do desconto bancada pelo vendedor; `total − seller` é a parte do ML |
| `cost` | APIs de Product Ads | investimento, por período/campanha — nunca por pedido |

Fórmula publicada pelo próprio Mercado Livre: `(unit_price * quantity) - marketplace_fee - seller.cost = valor líquido do pedido`.

**O que a doc NÃO diz — e por isso não pode ser presumido:**

- **A composição de `sale_fee`.** A doc nunca afirma se a taxa fixa está dentro ou fora. O texto adjacente ("alguns produtos podem incluir um custo fixo adicional à tarifa de venda") *sugere* estar fora — sugestão, não contrato.
- **A taxa fixa efetivamente cobrada por pedido.** Só existe como simulação (`GET /sites/{site}/listing_prices`, que exige `logistic_type`+`shipping_mode` corretos, senão "não coincidirá com o que realmente será cobrado") ou consolidada no faturamento mensal.
- **Taxa de parcelamento, custo de cobrança do MP, impostos retidos no MLB.** Só no faturamento (`/billing/integration/...`); `/perceptions/*` é explicitamente só Argentina.
- **Reembolsos posteriores.** A doc avisa que `/orders/{id}/discounts` exclui "taxas adicionais e reembolsos posteriores".

**Restrição oficial que decide a arquitetura:** o próprio ML afirma que os endpoints de Relatórios de Faturamento *"não devem ser utilizados como fonte de dados primária para gestão de vendas"*. Logo, **duas visões distintas e declaradas**: estimativa por pedido (tempo real) e conciliação por período (mensal). Nunca uma só chamada de "receita líquida".

**Estado do dado na V3, medido:** `order_items.sale_fee` **existe, está 100% preenchido em todas as janelas e nunca foi lido por ninguém** — R$ 297.993,32 em 30 dias sobre R$ 3.057.736,33 (9,75%). Frete do vendedor **não é persistido** (`orders` não guarda `shipping`). **Não existe L0**: o bucket `raw-ml` foi provisionado e nunca recebeu um byte, então não há de onde reconstruir taxa alguma retroativamente.

### Visitas — limites oficiais que invalidam a suposição de lote

`GET /items/{ITEM_ID}/visits/time_window` — **janela máxima de 150 dias**, `unit` aceita **só `day`**, e o erro `validation_parameters` diz literalmente *"maximum amount of items to query is 1"*: **não existe consulta em lote de itens**. O código atual já chama por item, então não há bug — mas qualquer plano que assuma `ids=A,B,C` está errado.

---

## 2.16 Republicação (relist) — CONFIRMADO com lacunas declaradas (leitura oficial, 2026-08-28, D-120)

Fonte: `developers.mercadolivre.com.br/pt_br/publique-seus-anuncios-novamente` (atualizada 29/12/2025), espelhada em EN/ES e nos domínios MLB/MLA/MLM. **Sem aviso de deprecação.** Nota de método: o portal devolve 403 para fetcher automatizado — só responde com User-Agent de navegador.

```
POST https://api.mercadolibre.com/items/{item_id}/relist
{ "price": 550000, "quantity": 1, "listing_type_id": "gold_special" }
```

**Contrato confirmado:**

| Regra | Situação |
|---|---|
| Pai precisa estar `closed` | ✅ Ativo → fechar via `PUT {"status":"closed"}` antes |
| **Uma republicação por item pai** | ✅ tag `relist` marca "não pode mais" |
| `parent_item_id` no filho | ✅ é o campo de vínculo pai→filho |
| Visitas e vendas transferidas | ✅ tags `dragged_visits` / `dragged_bids_and_visits`; **não** transfere em `listing_type_id: "free"` |
| **`variation_id` é RENOVADO** | ✅ literal: *"renovaremos o id do item e o id da variação"* |

**Quatro crenças que a doc oficial desmente:**

1. A tag **não** é `relisted` nem `item_relisted` — não existem. A oficial é **`relist`**.
2. `variation_id` **não** é preservado: é renovado. Remapear `variation_id → SKU` é etapa obrigatória, não cuidado opcional.
3. Os **60 dias não são prazo para republicar** — são a janela para **herdar as visitas**. A doc em nenhum lugar diz que o relist falha depois disso.
4. É **POST**, não GET.

**Vácuo documental — exige validação empírica antes de qualquer automação:**

- **Experiência de compra / reputação: a doc não afirma NADA, em nenhuma direção.** A página de Experiência de Compra não menciona relist, item pai ou herança uma única vez. Logo, "a experiência volta a 100%" não é apenas não-garantido: não há base para afirmar nem negar.
- **FULL: silêncio absoluto.** Zero ocorrências de "relist" nas páginas de Fulfillment, Convivência Full/Flex, User Products e Estoque Distribuído. A doc não diz o que acontece com o estoque físico no CD. **Bloquear é a única postura defensável.**
- **Catálogo: silêncio absoluto.** Nem permitido, nem bloqueado. **Bloquear.**
- **Idempotência NÃO EXISTE na API.** Busca por `idempot`, `X-Idempotency`, `Idempotency-Key` em todas as páginas: zero ocorrências. A proteção contra criar dois anúncios é 100% nossa.
- **Nenhum código de erro documentado** para `/relist`, nem HTTP status de sucesso.
- **Rate limit sem números** — só orientação qualitativa (backoff, jitter).
- **Relist encadeado** (filho vira pai) não é descrito; a página de Visitas diz que visitas são herdadas *"não importando quantas vezes o anúncio seja publicado novamente"*, o que tensiona com "uma por pai". Incerto.

**Defeito da própria doc, registrado:** o exemplo de resposta do relist **com variações** é internamente inconsistente — devolve o mesmo id do pai e `parent_item_id: null`, contradizendo o texto da página. Não tratar aquele shape como contrato.

**Achado extra:** `automatic_relist` é campo público em todos os exemplos e tem filtro de busca oficial (`with_automatic_relist`), mas **nenhuma página define o que faz**.

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
- ~~Endpoints de visitas e de Ads~~ — **Visitas pesquisado e implementado em 2026-08-23** (secao 2.11). **Ads pesquisado, mas ADIADO por D-059**: exige `advertiser_id` próprio com elegibilidade condicionada (reputação, tempo de conta, mínimo de vendas) — sem evidência de que a conta Mercado Livre da Speed Bikers tenha o produto habilitado; integração maior que um adendo a visitas, escopo próprio quando houver evidência real de necessidade.
- ~~Endpoints de Perguntas e Mensagens pós-venda (secao 2.12)~~ — **pesquisa oficial concluída em 2026-08-25 (D-083)**; modelo fechado em D-084, núcleo de banco criado em D-085 e contrato/mapper/persistência isolada de Perguntas concluídos em D-086. Próximo passo da Fase 7B: adaptador de detalhe + handler por `questionId`, ainda sem produtor de webhook/reconciliação/UI/resposta.

### Avisos operacionais encontrados na pesquisa, não bloqueantes hoje

- A partir de **30/08/2026** o Mercado Livre exige aplicações separadas entre Mercado Livre e Mercado Pago (uma aplicação por unidade de negócio) — relevante se a V3 vier a usar a API do Mercado Pago para conciliação financeira.
- A "vista atual" de `GET /orders/{order_id}/shipments` (retorna objeto único) será **descontinuada no fim de setembro/2026**, substituída pela "Hosted View" que **sempre** retorna array — desenhar o parser do worker já para o formato novo, não para o legado.
- Header `X-Api-Version: 2` é necessário em `/orders/{order_id}/shipments` para obter PII completo do destinatário (`receiver_name`, `receiver_phone`).
