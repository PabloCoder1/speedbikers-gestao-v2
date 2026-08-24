# Arquitetura V3 — Speed Bikers Gestão

> Status: **arquitetura inicial aprovada em 2026-08-19.**
> Este documento é o **mapa**. Ele decide e aponta; a profundidade de cada assunto vive no documento especializado indicado abaixo.
> Cada assunto tem **um único dono documental**. Não duplicar regra entre documentos.

| Assunto | Dono documental |
|---|---|
| Modelo de dados, tabelas, constraints, RLS | `docs/DATABASE.md` |
| Contratos entre web/api/worker, rotas, jobs, eventos | `docs/API.md` |
| Catálogo oficial de métricas | `docs/METRICS.md` |
| Integração Mercado Livre e sincronização | `docs/MERCADO_LIVRE.md` |
| ERP de origem (UpSeller): exportações e qualidade dos dados | `docs/UPSELLER.md` |
| Layout da NF-e/XML e mapeamento de campos | `docs/NFE.md` |
| Eventos e notificações em tempo real | `docs/NOTIFICATIONS.md` |
| Copiloto e uso de IA | `docs/COPILOT.md` |
| Plataformas, ambientes, secrets, CI/CD | `docs/DEPLOYMENT.md` |
| Estratégia e regras de teste | `docs/TESTING.md` |
| Decisões aprovadas e seus motivos | `docs/DECISIONS.md` |
| Ordem de construção | `docs/ROADMAP.md` |
| Estado atual e próximo passo | `docs/HANDOFF.md` |

---

## 1. Princípios de decisão

A V3 busca **a solução mais simples que cresce com segurança**. Toda peça de infraestrutura precisa passar nos três testes abaixo; reprovar em qualquer um a mantém fora da arquitetura.

1. **Teste da dor medida** — só entra infraestrutura que resolve um problema que a V2 mediu, não um problema imaginado.
2. **Teste do operador único** — o sistema é operado por uma pessoa. Cada plataforma, painel e linguagem de configuração adicional é custo permanente.
3. **Teste da porta de saída** — preferir a peça simples cuja substituição é local. Se trocar exige reescrever dezenas de arquivos, ela precisa ser muito melhor para entrar.

Princípios de produto herdados do `docs/PROMPT_MASTER.md`:

- SKU canônico é a entidade central; MLB é canal.
- `DADOS -> EVIDÊNCIAS -> REGRAS/ESTATÍSTICA -> DIAGNÓSTICO -> IA EXPLICA`.
- Ordem de construção: **confiabilidade dos dados -> métricas corretas -> histórico/eventos -> analytics -> diagnóstico -> ações -> IA**.
- A interface nunca depende de varredura da API do Mercado Livre em tempo real.

### O que deliberadamente NÃO usamos

Redis · Kafka · Kubernetes · Elasticsearch · pgvector/RAG · microserviços por domínio · event sourcing puro · CQRS formal · GraphQL · tRPC · ORM pesado · Supabase Edge Functions · arquitetura hexagonal com injeção de dependência · OpenTelemetry com coletor · APM pago · feature flags dinâmicas.

Nenhum passa nos três testes hoje. Reavaliar somente com gargalo medido, registrando nova decisão em `docs/DECISIONS.md`.

---

## 2. Visão geral

```text
                      Mercado Livre
                            |
              webhook       |       pull (cursor)
                            v
   +----------------------------------------------+
   |  apps/api            Cloud Run               |
   |  ACK <200ms · OAuth · comandos · Copiloto    |
   |  NUNCA trabalho longo inline -> enfileira    |
   +------------------+---------------------------+
                      | Cloud Tasks (4 filas)
                      v
   +----------------------------------------------+
   |  apps/worker         Cloud Run               |
   |  fetch -> normaliza -> persiste -> diff ->   |
   |  evento -> ledger -> marca chave suja        |
   +------------------+---------------------------+
                      v
   +----------------------------------------------+
   |  Supabase   Postgres + RLS + Realtime + Storage
   |  L1 operacional · L2 histórico · L3 analítico |
   +------------------+---------------------------+
                      | leitura sob RLS  +  Realtime
                      v
   +----------------------------------------------+
   |  apps/web            Vercel (gru1)           |
   |  renderiza · lê read models · assina eventos |
   +----------------------------------------------+

   Cloud Scheduler -> api -> reconciliação e backfill
   Cloud Storage   -> payload bruto (L0), com lifecycle
```

---

## 3. Monorepo

**pnpm workspaces + Turborepo.** Três apps, sete packages, `supabase/` na raiz (convenção da CLI da Supabase).

Regra de criação de package: **um diretório só vira package quando dois apps o importam.** Enquanto houver um único consumidor, mora dentro do app.

A estrutura completa de pastas está na seção 12.

---

## 4. apps/web — Vercel

Next.js App Router, região `gru1`.

**Faz:** renderização · sessão Supabase via cookies SSR · **leitura direta do Supabase sob RLS** (read models: views e RPCs indexadas) · Server Actions para escritas simples no escopo do usuário (marcar notificação lida, salvar filtro, confirmar vínculo, registrar decisão em ação) · assinatura do Realtime · consumo do stream SSE do Copiloto.

**Nunca:** chama a API do Mercado Livre · usa `service_role` · guarda segredo de integração · roda trabalho longo · agrega dados em JavaScript.

**Regra de fronteira:** *se a operação precisa de um segredo que o usuário não pode ver, ou pode demorar mais que um clique, não é o `web`.*

**Consequência aceita:** no Modelo A, a qualidade das policies de RLS **é** a segurança do sistema. Regras em `docs/DATABASE.md`; obrigatoriedade de teste negativo em `docs/TESTING.md`.

---

## 5. apps/api — Cloud Run

Servidor HTTP (Hono), `min-instances=1`, timeout curto, concorrência alta.

**Faz:**

- `POST /webhooks/mercado-livre` — ACK em milissegundos, **zero chamada de rede**, grava a notificação e enfileira.
- OAuth do Mercado Livre: início e callback com PKCE S256, guarda e refresh de token. O verifier PKCE e os tokens ficam cifrados; é onde os segredos vivem (D-046, D-049).
- **Comandos privilegiados** que o `web` não pode executar: disparar sync manual, confirmar NF-e, aprovar pedido de compra, disparar diagnóstico.
- **Copiloto**: orquestra ferramentas determinísticas e faz streaming SSE.
- Endpoints internos chamados por Cloud Scheduler e Cloud Tasks, autenticados por OIDC.

**Nunca:** trabalho longo inline. Se pode passar de ~5 s, **enfileira e responde**.

**`min-instances=1` não é otimização prematura:** é requisito do webhook. Cold start atrasa o ACK e provoca reentrega pelo Mercado Livre.

Rotas e contratos em `docs/API.md`.

---

## 6. apps/worker — Cloud Run

Sem rota pública. Alvo das Cloud Tasks. Timeout de até 15 min, concorrência baixa por instância, escala a zero.

**Faz:** consome job -> busca no ML -> normaliza -> persiste (L0 no Storage, L1 no Postgres) -> faz diff contra o estado anterior -> emite `domain_events` -> aplica ledger quando cabível -> marca chave suja para recálculo analítico.

**Por que é serviço separado da `api`:** os perfis de execução são opostos. A `api` quer timeout curto, concorrência alta e instância quente; o `worker` quer timeout longo, concorrência baixa e escala a zero. Um serviço único obrigaria a escolher a pior configuração para ambos e faria um backfill pesado competir com o ACK do webhook.

**Um worker, não um por domínio.** A separação que importa é de **fila**, não de serviço. O roteamento por tipo de job é uma tabela de handlers.

---

## 7. Packages compartilhados

| Package | Contém | Importado por |
|---|---|---|
| `@sb/contracts` | Schemas Zod e tipos: DTOs, payloads de job, payloads de evento, ferramentas do Copiloto | web, api, worker |
| `@sb/domain` | **Lógica pura, sem I/O**: fórmulas de métrica, regras do ledger, sugestão de compra, motor de diff, severidade, confiança | web, api, worker |
| `@sb/db` | Factories de client Supabase, tipos gerados do schema, helpers de query | web, api, worker |
| `@sb/mercado-livre` | Cliente ML: OAuth, backoff, cursor, classificação de erro, parsing tipado | api, worker |
| `@sb/ui` | **Previsto, não criado ainda** — design system: paleta oficial, componentes, estados de loading/erro/vazio/stale | web (futuro) |
| `@sb/observability` | Log estruturado, medição de operação, contexto de request | web, api, worker |
| `@sb/config` | Presets de eslint, tsconfig, tailwind | todos |

**Regra de contenção**: um package só nasce quando um SEGUNDO app precisa importar o mesmo código — antes disso, o código mora dentro do próprio app. É por isso que `@sb/ui` está na tabela acima mas não em `packages/`: `web` é o único app com UI hoje, então os tokens/componentes vivem em `apps/web` direto (ver `docs/HANDOFF.md`, achado registrado em 2026-08-22 corrigindo este drift).

### `@sb/domain` é a peça central do repositório

Toda regra de negócio determinística mora nele: sem banco, sem rede, sem framework. Roda em milissegundos e é testável exaustivamente.

**Regra da fórmula única:** cada fórmula tem **uma** implementação canônica em `@sb/domain`. Se também precisar existir em SQL por performance, a versão SQL é derivada e existe **teste de equivalência** rodando na CI. Sem exceção.

*Motivo, medido na V2:* a mesma fórmula de sugestão de compra existia em SQL e em TypeScript; o `numeric` do Postgres virando `double` do JavaScript fazia o `ceil` inventar uma unidade, produzindo **25 divergências em 76 linhas**.

Sub-domínios são *subpath exports* (`@sb/domain/stock`), não packages separados. Se um crescer demais, vira package sem quebrar imports.

---

## 8. Domínios

Dezenove contextos. Cada um é dono das suas tabelas. **Escrita cruzada é proibida**; leitura cruzada só por read model declarado.

`identity` · `ml-accounts` · `catalog` · `listings` · `sales` · `inventory` · `documents` · `purchasing` · `suppliers` · `linking` · `sync` · `events` · `analytics` · `diagnostics` · `actions` · `notifications` · `copilot` · `feedback` · `support`

**`support` (Fase 7B, D-071, conceitual — nenhuma tabela existe ainda):** Central de Atendimento/SAC — perguntas, mensagens, reclamações, devoluções, mediações e a Base de Conhecimento Validada. Lê `orders`/`skus`/`listings` só por read model declarado, como qualquer outro domínio; nunca escreve neles. Ver `docs/PRODUCT_REQUIREMENTS.md` e `docs/DATABASE.md`.

Na prática, um domínio é um diretório em `@sb/domain/<nome>` mais um prefixo de tabela. **A fronteira que precisa ser real é quem escreve na tabela** — imposta por `GRANT` no banco, não por convenção de pasta. Ver `docs/DATABASE.md`.

---

## 9. Camadas de dados

| Camada | Natureza | Regra que a define | Onde vive |
|---|---|---|---|
| **L0 — Bruto** | Payload cru do Mercado Livre | **Não fica no Postgres** | Cloud Storage, com lifecycle |
| **L1 — Operacional** | Estado atual | Uma verdade por fato. É o que a UI lê | Postgres |
| **L2 — Histórico** | Append-only, imutável | Nunca sofre `UPDATE`. É a memória e a evidência | Postgres |
| **L3 — Analítico** | Derivado | **100% recomputável** de L1+L2 | Postgres |

L0/L1/L2/L3 é **vocabulário**, não framework: não existe schema `l0`, nem classe base, nem abstração. Define nomenclatura, expectativa de mutabilidade e política de índice.

Detalhamento completo em `docs/DATABASE.md`.

---

## 10. Fluxo Mercado Livre -> interface

```text
Webhook ML -> api  POST /webhooks/mercado-livre
   ACK <200ms. Zero chamada de rede. Grava notificação e cria Cloud Task
   com nome = hash(recurso) -> notificações repetidas colapsam numa só.
                         |
Cloud Scheduler -> api --+ reconciliação por janela + backfill (fila de prioridade baixa)
                         v
                 Cloud Tasks — taxa limitada POR CONTA
                         v
                 worker — handler idempotente
                   1. busca no ML (cursor, backoff com jitter, honra Retry-After)
                   2. grava L0 no Storage -> normaliza -> atualiza L1
                   3. diff contra estado anterior -> emite domain_events (L2)
                   4. aplica ledger quando cabível (idempotency_key)
                   5. marca conta + dia sujos; enfileira uma janela de minuto com 60s de atraso
                         v
                 recálculo incremental -> L3
                         v
                 Supabase: Postgres + RLS + Realtime
                         v
                 web: read model indexado + Realtime
```

### Chave suja

Depois que uma janela de reconciliação termina de persistir seus pedidos, o worker enfileira uma task por conta + dia de negócio, com atraso de 60 s: `recompute:{account-uuid}:{data}:{janela-minuto-UTC}`. O UUID é obrigatório porque o slug só é único dentro da organização e a fila é compartilhada. **Tasks da mesma janela de minuto são deduplicadas pela própria fila** — um burst de cem vendas produz um recálculo; uma venda em minuto posterior produz outro ID e não é perdida.

O sufixo de minuto é obrigatório (D-051): o Cloud Tasks pode reter por até 24 horas o ID de uma task já executada. O ID antigo, fixo por SKU/dia, aceitaria o primeiro recálculo e descartaria atualizações posteriores como `ALREADY_EXISTS`. A RPC recalcula os três grãos da conta/dia de uma vez e usa advisory lock por conta; `sku` deixou de ser parte da task porque não limita o trabalho SQL real.

*Motivo, medido na V2:* o dashboard mostrava 28 pedidos / R$ 2.201 quando `orders` já tinha 110 pedidos / R$ 9.532 — 4x a menos. Não era erro de cálculo, era latência de agendamento (uma conta por invocação, ~16 min por conta). Fila com dedupe elimina a categoria inteira do problema.

---

## 11. Filas e jobs

**Cloud Tasks é a fila. O Postgres registra o executado (`job_runs`), não a fila.**

Cloud Tasks elimina lease, claim, contador de retry, despachante e dead-letter artesanal — e entrega três coisas que a V2 precisou emular mal:

- **dedupe por nome de task** (base da chave suja);
- **taxa e concorrência máximas por fila** (base do respeito ao rate limit por conta);
- **retry com backoff nativo**, independente de o processo sobreviver.

*Motivo, medido na V2:* seis RPCs de claim readquiriam lease sem incrementar contador — job preso em `running` para sempre, nunca virando falha, nunca alertando, consumindo uma Function por minuto. Mais cinco despachantes `pg_cron` por minuto varrendo filas quase sempre vazias.

**Custo aceito:** a fila deixa de ser consultável por SQL. Mitigação: o worker grava `job_runs` no Postgres com início, fim, resultado e erro. Perde-se a visão do *pendente*; mantém-se a visão completa do *executado*.

**Quatro filas, não quinze:**

| Fila | Papel | Característica |
|---|---|---|
| `ml-sync-<conta>` | Sincronização com o Mercado Livre | **Uma fila por conta** — o limite do Cloud Tasks é por fila (D-036) |
| `analytics-recompute` | Recálculo de métricas | Dedupe forte por nome |
| `backfill` | História | Prioridade baixa, nunca disputa com o vivo |
| `maintenance` | Conferência, expurgo, medição | Baixa frequência |

`pg_cron` permanece disponível **apenas para manutenção do banco** (conferência de saldo, expurgo, `ANALYZE`). Nunca para despachar fila.

**Exceções registradas em 2026-08-21:** o `worker` enfileira em duas filas, ambas porque só ele descobre que o trabalho passou a existir: em `backfill`, cada pedaço concluído cria o próximo; em `analytics-recompute`, uma reconciliação persistida marca os dias sujos. A service account recebe `cloudtasks.enqueuer` somente nessas duas filas, nunca no projeto. A `api` continua produtora de todas as demais tasks.

---

## 12. Estrutura de pastas

```text
speedbikers-gestao-v2/                    (branch v3)
├── apps/
│   ├── web/                              Next.js -> Vercel
│   │   ├── app/                          (auth) (dashboard) (produtos)
│   │   │                                 (estoque) (compras) (admin)
│   │   ├── components/                   composições específicas de tela
│   │   └── lib/                          supabase server/client, sessão
│   ├── api/                              Hono -> Cloud Run  [min-instances=1]
│   │   ├── src/routes/                   webhooks/ oauth/ commands/ copilot/ internal/
│   │   ├── src/middleware/               auth-jwt, auth-oidc, request-context
│   │   └── Dockerfile
│   └── worker/                           Cloud Run  [timeout 15min, escala a zero]
│       ├── src/handlers/                 sync-orders, sync-listings, recompute-metrics,
│       │                                 detect-events, apply-ledger, reconcile-balances
│       ├── src/router.ts                 tipo de job -> handler
│       └── Dockerfile
│
├── packages/
│   ├── contracts/                        dto/ jobs/ events/ copilot-tools/   (Zod)
│   ├── domain/                           stock/ analytics/ purchasing/ diagnostics/
│   │                                     events/ linking/ metrics/           (PURO)
│   ├── db/                               client/ types/ queries/
│   ├── mercado-livre/                    oauth/ orders/ items/ fulfillment/ http/
│   ├── ui/                               primitives/ patterns/ charts/ theme/
│   ├── observability/
│   └── config/                           eslint/ tsconfig/ tailwind/
│
├── supabase/
│   ├── migrations/                       fonte da verdade do schema
│   ├── seed/
│   └── config.toml
│
├── infra/
│   ├── setup-dev.sh                      gcloud versionado
│   ├── cloud-tasks-queues.sh
│   └── README.md
│
├── docs/
├── .github/workflows/ci.yml
├── turbo.json
├── pnpm-workspace.yaml
└── .env.example
```

---

## 13. Eventos

**Uma tabela `domain_events`, carregando `before` e `after`. Sem tabelas de snapshot separadas.**

O estado atual já vive em L1. O que falta é *o que mudou e quando* — e isso é exatamente o evento. Guardar snapshot completo a cada varredura duplica L1 e cresce sem limite; guardar **só quando mudou, com antes e depois**, dá a mesma linha do tempo por uma fração do volume.

`dedup_key` UNIQUE garante que reprocessar um job não duplica evento — o que importa porque evento duplicado vira **notificação duplicada** na tela do usuário.

**Isto não é event sourcing.** L1 continua sendo a verdade e é atualizado diretamente. Os eventos são registro do que mudou, não o mecanismo de reconstrução do estado.

Consumidores: notificações · diagnóstico (evidência datada) · Central de Ações · anotação em gráficos.

Schema e catálogo de tipos de evento em `docs/DATABASE.md` e `docs/API.md`.

---

## 14. Estoque, Full e documentos

Regras estruturais; detalhe em `docs/DATABASE.md`.

- **`stock_movements` é o único escritor da verdade de estoque local.** `inventory_balances` é projeção recomputável, com job de conferência que compara projeção contra a soma do ledger e emite evento crítico na divergência.
- **`idempotency_key` UNIQUE é a garantia inteira** — constraint de banco, não validação de aplicação. A mesma venda, webhook ou NF-e fisicamente não conseguem movimentar duas vezes.
- **A venda vira linha no ledger no momento em que o pedido é persistido.** O custo é pago uma vez na escrita e a leitura é uma soma indexada. *Motivo:* a V2 calculava a dedução na leitura e gastou seis migrations em dois dias brigando com timeout.
- **Full é espelho do Mercado Livre, não ledger nosso.** A autoridade é o ML; armazenamos snapshots com histórico. Um ledger só é confiável se observamos todos os movimentos, e os movimentos internos do CD do ML não são visíveis. Eventos de Full (entrou, saiu, rompeu, repôs) saem do **diff entre snapshots**.
- **Local, Full por conta, reservado e em trânsito são quatro estados com quatro autoridades diferentes.** A interface mostra os quatro separados e nunca soma cegamente num "estoque total" sem dizer o que ele contém.
- **NF-e:** `upload -> parse -> identificar -> relacionar por SKU -> conferência -> destacar não vinculados -> confirmação humana -> gerar movimentos`. Parse e movimentação são atos distintos em momentos distintos. `content_hash` UNIQUE impede reaplicação. XML é a fonte estruturada; PDF/DANFE é fallback e só entra depois do XML estar sólido.

---

## 15. Analytics

Um fato diário no grão do anúncio, dois rollups derivados, **todos gerados pelo mesmo código** com teste de equivalência na CI.

```text
daily_listing_metrics   <- fato: (ml_account_id, mlb_id, variation_id, metric_date)
daily_sku_metrics       <- rollup
daily_account_metrics   <- rollup
```

Volume estimado: 4 contas x ~2.000 anúncios x 365 dias ~= 2,9 M linhas/ano no fato. Os rollups existem porque um dashboard de conta em 90 dias varreria ~720 mil linhas do fato por consulta.

Recálculo incremental por chave suja (seção 10). Rebuild completo disponível e testado.

**Regras inegociáveis:**

- **Zero agregação em JavaScript.** *Medido na V2:* mover para SQL deu 119 ms contra 1.343 ms — 11x — eliminando 10.286 linhas trafegadas por chamada.
- **Todo número na tela carrega o ID da sua definição de métrica.** Catálogo normativo em `docs/METRICS.md`.
- Dia civil em `America/Sao_Paulo`, com helper canônico único e testado.

---

## 16. Diagnóstico e Central de Ações

Pipeline determinístico em `@sb/domain/diagnostics`, com a IA **narrando no fim e nunca no meio**:

```text
janela + escopo
  -> coleta de sinais (vendas, visitas, conversão, preço, estoque, Full, promoção, Ads, catálogo)
  -> baseline e desvio (estatística, não LLM)
  -> candidatos a causa correlacionados com domain_events datados
  -> confiança calculada por regra
  -> [opcional] IA escreve a explicação citando SÓ as evidências recebidas
```

**O evento datado é o que faz isso funcionar.** Sem a linha do tempo de eventos, qualquer diagnóstico é conjectura com boa redação. É por isso que a Fase 3 precede a Fase 6 — é dependência de dados, não preferência.

Contrato de saída, sempre: `{ evidencias[], causas_candidatas[], confianca, escopo, periodo, proximos_passos[] }`. O mesmo contrato é consumido pela Central de Ações e pela ação contextual "O que aconteceu?".

**Sem machine learning para detecção de anomalia.** Média móvel, desvio padrão e comparação com o mesmo dia da semana anterior cobrem o caso real.

**Central de Ações:** uma tabela `actions` unificando problema e oportunidade — são o mesmo objeto com sinal invertido, e separar duplica toda a UI. Priorização por `impacto financeiro x urgência x confiança`, nunca por contagem de alerta. *Motivo:* a V2 chegou a 5.243 alertas abertos; cinco mil alertas não são cinco mil problemas, são uma tela que ninguém abre. A Central precisa ser desenhada para caber numa tela.

**Memória de decisões:** capturar o `baseline_snapshot` **no momento da decisão** é o que torna a medição posterior possível. Sem ele, comparar depois é impossível.

---

## 17. Notificações e Copiloto

Resumo; regras completas em `docs/NOTIFICATIONS.md` e `docs/COPILOT.md`.

- Notificações derivam de `domain_events` por regra versionada, respeitam permissão por conta e são **agrupadas por janela** — sem agrupamento, o primeiro backfill vira avalanche de popups e o usuário desliga a feature no primeiro dia.
- Transporte por Supabase Realtime, começando com `postgres_changes` filtrado por `user_id`.
- O Copiloto é **tool calling sobre ferramentas determinísticas tipadas**, não um chat com acesso ao banco. Nenhuma SQL é gerada por LLM. Quando a ferramenta responde por completo, a UI renderiza o resultado e **o LLM não é chamado**.
- O Copiloto lê e explica; **não executa ações de escrita**.

---

## 18. Segurança, RBAC e RLS

- **RLS em toda tabela exposta à Data API**, com helpers `STABLE` (`current_org_id()`, `has_account_access()`, `has_role()`).
- **Marcar `STABLE` corretamente é decisão de performance, não de estilo:** funções de RLS entram no plano de toda consulta. Marcada `VOLATILE`, cada leitura vira chamada por linha. É o modo mais comum de um sistema com RLS ficar lento de forma invisível.
- Papéis: ADMIN · GESTOR · ANALISTA · OPERADOR · VISUALIZADOR, mais escopo por conta em `user_account_permissions`.
- `service_role` apenas em `api` e `worker`, via Secret Manager. Nunca na Vercel, nunca no bundle, nunca em log.
- **Autenticação serviço-a-serviço por OIDC de service account**, não por segredo compartilhado.
- Tokens do Mercado Livre cifrados em repouso, chave no Secret Manager. Nunca em log, nem parcialmente.
- **Webhook é superfície pública com autenticação própria e caminho explicitamente liberado, com teste negativo nas rotas vizinhas.** *Motivo:* na V2 o proxy exigia sessão, o webhook não envia cookie, e as notificações de preço, promoção e Full morriam em silêncio num 307 para `/login`.

Detalhamento em `docs/DATABASE.md` (policies) e `docs/DEPLOYMENT.md` (secrets).

---

## 19. Plataformas e ambientes

| Plataforma | Papel | Fora de escopo |
|---|---|---|
| **Vercel** | `apps/web`, região `gru1` | Nenhum worker, nenhum trabalho longo |
| **Supabase** | Postgres, Auth, RLS, Realtime, Storage | **Sem Edge Functions** |
| **Google Cloud** | Cloud Run (2), Cloud Tasks (4 filas), Scheduler, Secret Manager, Storage, Logging | Sem GKE, Compute Engine, Cloud SQL, Load Balancer, VPC customizada |

Três ambientes: **local · development · production**. Preview da Vercel aponta para o Supabase Dev. Detalhes, secrets, CI/CD e infraestrutura como código em `docs/DEPLOYMENT.md`.

*Nota medida na V2:* `gru1` e Supabase `sa-east-1` são ambos São Paulo, sem salto entre regiões. A auditoria descartou a hipótese de que a Vercel fosse o gargalo — os gargalos eram agregação em JavaScript, índice ausente e polling.

---

## 20. Observabilidade

O mínimo que responde às perguntas reais:

1. **Log estruturado JSON** nos três apps, com `request_id` / `job_id` correlacionando.
2. **`job_runs` no Postgres** — início, fim, resultado, erro, itens processados. Responde "o que rodou e como foi".
3. **`sync_runs` / `sync_errors` / freshness por conta** — vira a tela de Saúde da Sincronização, que é observabilidade **para o usuário**.
4. **Alerta no Cloud Logging** para taxa de erro e fila crescendo.
5. **Medição de leitura lenta** — logar quando um read model passa de 1.500 ms.

**Não construir dashboard de observabilidade.** *Motivo:* a V2 tinha uma RPC de saúde custando 550–700 ms **sem nenhuma UI consumindo**. Instrumentação sem consumidor é custo puro.

---

## 21. Performance

Orçamento (metas de projeto, não garantias): dashboards principais p95 <= ~1,5 s · filtros comuns p95 < 2 s · busca por SKU percebida como instantânea · ACK de webhook em milissegundos.

Cinco regras estruturais, todas extraídas de gargalo medido na V2:

1. **Zero agregação em JavaScript.**
2. **Read model por tela**, com índice desenhado a partir da consulta real.
3. **`select` com colunas explícitas** — nunca `select *`.
4. **Consultas independentes em paralelo**, nunca em cascata.
5. **A UI nunca dispara chamada ao ML nem à IA no carregamento da página.**

Processo: `EXPLAIN (ANALYZE, BUFFERS)` em toda RPC nova antes do merge · `pg_stat_statements` revisado ao fim de cada fase · não otimizar sem medir antes.

---

## 22. Pontos em aberto

**Nenhuma decisão de produto segue aberta.** Os oito itens que estavam pendentes ao fim da sessão de arquitetura foram respondidos e registrados como **D-027 a D-034** em `docs/DECISIONS.md`.

Duas dessas respostas alteraram o desenho e estão refletidas neste documento:

- **O UpSeller permanece como ERP** (D-028) e movimentos manuais são lançados nos dois sistemas. A reconciliação passa a fazer parte do núcleo do estoque, com o ERP vencendo em divergência através de um movimento `AJUSTE_RECONCILIACAO` auditável (D-029). O ledger da V3 nasce completo e autossuficiente, preservando o caminho para a V3 assumir como ERP sem reescrita.
- **A Fase 5 foi dividida** (D-033). A tela âncora é o Dashboard de vendas, que não depende do estoque; a Fase 5A roda antes da Fase 4 e a 5B depois. Ver `docs/ROADMAP.md`.

Permanecem abertas apenas pendências de **informação externa**, não de decisão:

- confirmação da documentação oficial do Mercado Livre antes de congelar o capítulo de sincronização (`docs/MERCADO_LIVRE.md`), que bloqueia a Fase 3;
- amostra real das planilhas do UpSeller, necessária antes da Fase 2;
- modelos de exportação do pedido de compra em Excel e PDF, a solicitar antes da Fase 4.
