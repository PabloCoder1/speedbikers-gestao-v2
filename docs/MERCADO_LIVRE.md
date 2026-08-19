# Integração Mercado Livre — Speed Bikers Gestão V3

> Dono documental de: estratégia de sincronização, regras de integração e registro de endpoints.
> Status: **estratégia aprovada. Endpoints e tópicos NÃO preenchidos.**

---

## REGRA ABSOLUTA

**Nunca inventar endpoint, payload, escopo, política ou comportamento da API do Mercado Livre** (`docs/PROMPT_MASTER.md` §9).

Antes de implementar qualquer integração que dependa de comportamento atual:

1. consultar a documentação oficial vigente;
2. registrar o endpoint e o escopo **neste arquivo**;
3. considerar paginação, rate limit, erros e idempotência;
4. escrever teste com fixture gravado.

Este arquivo tem seções deliberadamente vazias. **Seção vazia é sinal de trabalho pendente, não de esquecimento.** Preenchê-la com suposição é pior que deixá-la vazia.

---

## 1. Lista de verificação pendente

Precisa ser confirmado na documentação oficial **antes** da Fase 3:

- [ ] Tópicos de webhook disponíveis atualmente e seus payloads
- [ ] Mecanismo oficial de recuperação de notificações perdidas
- [ ] Política de rate limit vigente: limites, janelas e cabeçalhos de resposta
- [ ] Modelo de autorização multi-conta — **se a autorização centralizada pelo ADMIN é possível** (`docs/PROMPT_MASTER.md` §10)
- [ ] Endpoints e paginação de pedidos
- [ ] Endpoints e paginação de anúncios e variações
- [ ] Endpoints de estoque Full
- [ ] Endpoints de promoções e catálogo
- [ ] Endpoints de visitas e de Ads — necessários apenas na Fase 5B (D-032)
- [ ] Escopos de OAuth necessários por recurso
- [ ] Política de validação de origem do webhook

A autorização centralizada é **restrição externa, não preferência de arquitetura**. O schema previsto em `docs/DATABASE.md` atende aos dois cenários, portanto essa pendência não bloqueia a Fase 2.

---

## 2. Registro de endpoints

> A preencher conforme a lista de verificação for concluída. Cada linha deve citar a data da consulta à documentação oficial.

| Recurso | Endpoint | Escopo | Paginação | Rate limit | Confirmado em |
|---|---|---|---|---|---|
| _(vazio — pendente de confirmação oficial)_ | | | | | |

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

### Reconciliação

- Janela por cursor, executada por Cloud Scheduler.
- Compara o que existe localmente com a janela remota e enfileira apenas as diferenças.
- Registra em `sync_runs` a distância entre `now()` e o registro mais recente importado — é o dado que alimenta a tela de Saúde da Sincronização.

### Backfill

- Retomável por checkpoint.
- **Fila de prioridade baixa**, para nunca disputar capacidade com o tráfego vivo.
- A auditoria da V2 registrou 17 respostas HTTP 429 em 24 h entre 4 contas **sem backfill em execução**. Backfill competindo com sync ao vivo agrava isso diretamente.

---

## 4. Regras transversais de integração

| Regra | Detalhe |
|---|---|
| **Paginação por cursor** | **Nunca por offset.** A V2 paginava por offset sobre resultado ordenado por data decrescente; pedidos novos durante a varredura deslocavam o offset, e sob pico um pedido podia escapar entre páginas |
| **Rate limit** | Controlado pela fila `ml-sync`, com limite de taxa e concorrência **por conta** |
| **429 e 5xx** | Backoff exponencial com jitter, honrando `Retry-After` |
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

O refresh de token usa lock para evitar corrida entre execuções concorrentes — desenho herdado da V2, que estava correto.

---

## 7. Pendências

- Todo o conteúdo da seção 2. **Bloqueia a Fase 3.**
- Confirmação da viabilidade da autorização centralizada pelo ADMIN.
- Visitas e Ads são necessários apenas na Fase 5B (D-032), portanto podem ser confirmados depois.
