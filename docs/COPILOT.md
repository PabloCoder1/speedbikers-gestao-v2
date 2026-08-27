# Copiloto Speed Bikers

> Dono documental de: arquitetura do assistente, registro de ferramentas, guardrails e uso de IA.
> Status: **estratégia aprovada. Ferramentas determinísticas + `ai_runs` implementados em 2026-08-25 (D-077)** — `POST /v1/copilot/query`, `apps/api/src/copilot.ts`, schemas em `@sb/contracts`. Modelo/orçamento decididos em 2026-08-25 (D-082) e a primeira ferramenta com LLM de verdade, `narrate_sku_diagnosis`, já implementada — planner por linguagem natural, streaming SSE de verdade e UI de chat continuam pendentes, sem mais bloqueio de decisão de produto.

---

## 1. O que o Copiloto é e o que não é

**É** um orquestrador de ferramentas determinísticas tipadas, integrado à interface, com consciência da tela aberta.

**Não é** um chat com acesso ao banco. Não é um agente autônomo. Não escreve SQL. Não executa ações.

---

## 2. Fluxo

```text
pergunta + contexto da tela (rota, entidade, filtros, período)
   -> planner escolhe entre ferramentas REGISTRADAS e TIPADAS
   -> cada ferramenta executa SQL/RPC sob as permissões do usuário
   -> se a ferramenta já respondeu por completo:
         renderiza card, o LLM NÃO é chamado
      senão:
         o LLM explica, citando SÓ as evidências recebidas
   -> resposta com evidencias[] · escopo · links[] · confianca
```

O **curto-circuito** é o que cumpre a regra de custo e confiança do `docs/PROMPT_MASTER.md` §30:

| Pergunta | Caminho |
|---|---|
| "Qual o estoque do SKU X?" | Consulta. Card renderizado. **LLM não é chamado** |
| "Quantas unidades vendeu em 30 dias?" | Consulta. Card renderizado. **LLM não é chamado** |
| "Qual a variação percentual?" | Cálculo determinístico. **LLM não é chamado** |
| "Por que este produto caiu?" | Diagnóstico determinístico -> LLM narra as evidências |
| "Estruture esta ideia de feature" | LLM, com saída estruturada |

**Nunca usar LLM para algo que SQL, regra ou cálculo determinístico resolve melhor.**

---

## 3. As três regras que tornam isso seguro e barato

1. **Nenhuma SQL é gerada por LLM.** Apenas ferramentas do registro. Isso elimina injeção de SQL, vazamento entre contas e varredura acidental de tabela inteira.
2. **Permissão é aplicada na camada de ferramenta, não no prompt.** Prompt não é mecanismo de autorização. Cada ferramenta recebe a identidade do usuário e respeita RBAC e escopo por conta.
3. **Toda chamada é registrada em `ai_runs`** com custo, latência, ferramentas usadas, escopo e período. Sem isso, o custo é descoberto na fatura.

---

## 4. Registro de ferramentas

Ferramentas são definidas em `@sb/contracts/copilot-tools` com schema Zod de entrada e saída. Categorias previstas:

| Categoria | Exemplos |
|---|---|
| Consulta pontual | estoque por SKU, preço vigente, status do anúncio |
| Série temporal | vendas por período, evolução de preço, visitas |
| Comparação | SKU entre contas, período contra período |
| Diagnóstico | executa o pipeline determinístico e devolve o contrato de evidências |
| Prioridade | o que precisa de atenção, o que é urgente em compras |
| Estruturação | transforma ideia em sugestão de feature estruturada |

Ferramenta nova exige: schema tipado, verificação de permissão, teste, e entrada neste documento.

**Implementadas em 2026-08-25 (D-077)** — as três primeiras da tela âncora (secao 10), categoria "Série temporal"/"Comparação", `packages/contracts/src/copilot-tools.ts` + `apps/api/src/copilot.ts`:

| Ferramenta | Categoria | O que faz |
|---|---|---|
| `sales_summary` | Série temporal | Vendas de um período — mesma `get_sales_summary` de `/vendas`, geral ou por conta |
| `sales_period_comparison` | Comparação | O mesmo período contra o período anterior de igual tamanho (`previousBusinessDateRange`, `@sb/domain`) |
| `sales_account_comparison` | Comparação | O mesmo período, lado a lado entre 2 e 10 contas |

Verificação de permissão: RLS de verdade, não RBAC reimplementado — cada ferramenta roda com um `UserClient` (`@sb/db`) autenticado como o próprio usuário, então `has_account_access`/`get_sales_summary security invoker` já filtram sem código extra (secao 3, regra 2). Nenhuma ferramenta de escrita.

**`narrate_sku_diagnosis` implementada em 2026-08-25 (D-082)** — categoria "Diagnóstico", primeira (e única, nesta fatia) ferramenta que chama LLM de verdade. Não produz diagnóstico: recebe o contrato de `diagnoseSalesAnomaly` (`@sb/domain`, D-063/D-078) já calculado pelo chamador e pede ao Claude Haiku 4.5 para narrar em português, citando só o que está no contrato (`apps/api/src/copilot.ts`, prompt em `DIAGNOSIS_NARRATION_SYSTEM_PROMPT`). A `api` revalida sob RLS que o usuário alcança o `skuId` antes de narrar, mas não recalcula o diagnóstico — evita duplicar a agregação pesada de `get_sku_sales_baseline`/`domain_events`, que já roda em `apps/web` (D-078). Botão "Narrar com IA" em `apps/web/app/skus/[skuId]/diagnosis-panel.tsx`, só aparece quando há anomalia — fetch client-side direto para a `api` (mesmo padrão de `confirm-apply-form.tsx`: sessão do navegador, `access_token` no header `Authorization`), porque a chave da Anthropic só existe em `apps/api`/Secret Manager, nunca na Vercel.

---

## 5. Contexto de tela

O Copiloto recebe, quando disponível: rota atual, entidade selecionada (SKU, MLB, conta), filtros ativos e período.

**A resposta sempre mostra o escopo e o período efetivamente usados.** Se o usuário perguntou algo mais amplo que o filtro da tela, o Copiloto declara qual escopo aplicou.

**Nunca inventar dado ausente.** Se a métrica não existe ou a fonte não está confirmada, a resposta diz isso — ver `docs/METRICS.md`.

---

## 6. Escopo deliberadamente excluído

- Sem RAG, sem embeddings, sem pgvector.
- Sem memória de conversa persistida além da sessão.
- **Sem ferramenta de escrita.** O Copiloto lê e explica; não altera preço, não cria pedido, não movimenta estoque.

Ferramenta de escrita é uma fronteira de risco que não está nos requisitos e não será cruzada sem decisão explícita registrada em `docs/DECISIONS.md`.

---

## 7. "O que aconteceu?" não é o Copiloto

A ação contextual em KPIs, gráficos, produtos e contas executa o **pipeline determinístico** de `@sb/domain/diagnostics` e devolve o contrato de `docs/API.md`:

```text
{ escopo, evidencias[], causas_candidatas[], confianca, proximos_passos[] }
```

A narração pelo LLM é **opcional** e posterior. `causas_candidatas` só pode referenciar itens presentes em `evidencias`. A IA narra o contrato; não o produz.

Mesmo contrato, mesmas evidências, consumido também pela Central de Ações.

---

## 8. Sugestões de features

**Captura + Central de Sugestões implementadas em 2026-08-25 (D-079)** — `apps/web/app/sugestoes`, `feature_suggestions` (`docs/DATABASE.md`). "Ferramenta dedicada" ainda não existe como ferramenta do Copiloto (secao 4) — nesta fatia o envio é um formulário comum, sem passar por `POST /v1/copilot/query`; virar ferramenta registrada é trabalho de quando o planner por linguagem natural existir (secao 10).

**O texto original do usuário é preservado íntegro**, em coluna separada da versão estruturada.

A IA gera, quando possível: título, problema, objetivo, usuários impactados, fluxo sugerido, benefício esperado, critérios de aceite, dependências e riscos aparentes, complexidade a avaliar, autor e data. **Pendente** — colunas já existem em `feature_suggestions`, nascem `null`; sem UI de preenchimento manual nesta fatia (o requisito atribui a estruturação à IA, não a um humano preenchendo à mão). Autor e data não dependem de IA — já aparecem na Central via `created_by`/`created_at`.

*Motivo de preservar o original:* a estruturação pode errar a intenção. Quando a sugestão for lida três semanas depois, o que o usuário realmente escreveu é a única fonte confiável. Sobrescrever perde informação de forma irreversível.

Estados na Central de Sugestões: `nova` -> `em_analise` -> `aprovada` -> `planejada` -> `em_desenvolvimento` -> `entregue` -> `recusada`. Qualquer membro da organização envia e vê todas as sugestões; só ADMIN/GESTOR muda o estado (mesma granularidade de `purchase_orders`/`actions`).

---

## 9. Custo e transporte

- Streaming SSE a partir de `apps/api` — **ainda não implementado**. `POST /v1/copilot/query` devolve JSON síncrono mesmo para `narrate_sku_diagnosis` (D-082) — a resposta do Haiku 4.5 é curta (2-4 frases, `max_tokens: 512`), não há ganho de latência percebida que justifique streaming para este tamanho de resposta ainda. Streaming entra quando o planner/chat existir, respostas mais longas.
- **Toda chamada é rastreável desde D-077** — `ai_runs` grava ferramenta(s), escopo e latência de toda chamada. Desde D-082, `llm_used`/`cost_usd` deixam de ser sempre `false`/`null`: `narrate_sku_diagnosis` grava o custo REAL em USD, calculado a partir do `usage.input_tokens`/`usage.output_tokens` que a própria resposta da Anthropic devolve (`apps/api/src/anthropic-client.ts`) — nunca estimado.
- **A interface nunca dispara chamada de IA no carregamento da página.** A V2 precisou de um teste dedicado para garantir isso, e a ideia vale ser mantida. `narrate_sku_diagnosis` (D-082) só dispara em clique explícito no botão "Narrar com IA", nunca automaticamente ao abrir o Dashboard de SKU.
- **Modelo e orçamento decididos em 2026-08-25 (D-082)**: Anthropic Claude Haiku 4.5, teto de R$100/mês, política de AVISAR (não bloquear) ao ultrapassar. "Configurável por organização" continua aspiração futura — só existe uma organização real hoje, o teto nasce como valor único (`AI_MONTHLY_BUDGET_USD`, worker), não por organização. **Mecanismo de aviso implementado em 2026-08-27 (D-100)**: job diário `maintenance.check-ai-budget` soma `ai_runs.cost_usd` do mês de negócio (`get_ai_monthly_cost_usd`, SQL) e emite `ai.budget.exceeded` (importante) ao ultrapassar — entregue pela cadeia de notificações de D-073, um aviso por organização por mês via `dedup_key`. Nenhuma chamada é bloqueada em nenhum caso, exatamente como decidido. Operação pendente de deploy autorizado — ver D-100.

---

## 10. Pendências

- ~~Escolha do modelo e orçamento de custo por período~~ — **decidido em 2026-08-25 (D-082)**: Anthropic Claude Haiku 4.5 (narração curta + planner simples não exigem um modelo maior), teto de R$100/mês, avisa o ADMIN ao ultrapassar mas continua permitindo chamadas (não bloqueia). Chave nova no Secret Manager do GCP para `apps/api` — a `ANTHROPIC_API_KEY` herdada da V2 (projeto Vercel, sem consumidor) não é reaproveitada, por estar no lugar errado e ter validade incerta.
- ~~Narração de evidências ("Por que este produto caiu?")~~ — **implementada em 2026-08-25 (D-082)**: `narrate_sku_diagnosis` (secao 4), botão "Narrar com IA" no Dashboard de SKU. **Ainda pendentes, sem bloqueio de decisão de produto**: o planner que escolhe a ferramenta a partir de linguagem natural, streaming SSE de verdade, a UI de chat, e a estruturação por IA das sugestões de feature (secao 8, D-079). O mecanismo de aviso de orçamento foi implementado em 2026-08-27 (D-100, secao 9). Ver D-082 em `docs/DECISIONS.md`.
- ~~As primeiras ferramentas acompanham a tela âncora, o Dashboard de vendas Geral e por Conta (D-033): vendas por período, comparação entre períodos e comparação entre contas.~~ **Implementadas em 2026-08-25 (D-077)** — ver secao 4.

---

## 11. Sugestão de resposta de atendimento (Fase 7B, conceitual)

> Registrado em 2026-08-24 (D-071), junto com a Central de Atendimento/SAC — `docs/PRODUCT_REQUIREMENTS.md`, `docs/ROADMAP.md` Fase 7B. Atualizado em 2026-08-27: a infraestrutura em volta já existe por completo — ingestão de Perguntas (D-086 a D-089), Caixa de Entrada e detalhe (D-090/D-095), triagem (D-094), **envio manual de resposta** (D-096, `POST /v1/support/cases/:caseId/reply` — o comando privilegiado do fluxo abaixo, exatamente como desenhado aqui) e Mensagens pós-venda (D-097). **O que continua não implementado é a sugestão pelo Copiloto em si** — a ferramenta de geração de texto (`suggested_text` existe como coluna, nunca preenchida) e a Base de Conhecimento Validada.

Categoria de ferramenta nova: gera o **texto** de uma resposta a pergunta, mensagem, reclamação ou mediação — mesma família de "Estruturação" (secao 4, "transforma ideia em sugestão de feature estruturada"), **não** uma ferramenta de escrita. A regra da secao 6 ("sem ferramenta de escrita") continua valendo sem exceção: o Copiloto nunca chama uma tool que envia mensagem ao Mercado Livre.

Fluxo:

```text
ATENDIMENTO + contexto determinístico
   -> ferramentas registradas buscam evidências (SKU, anúncio, pedido,
      compatibilidade, histórico, Base de Conhecimento Validada)
   -> Copiloto sugere o texto da resposta
   -> usuário revisa, edita se quiser, confirma
   -> SOMENTE ENTÃO um comando privilegiado da `api` envia
      (mesmo padrão de "confirmar NF-e"/"aprovar pedido de compra",
      docs/API.md secao 2) — nunca uma tool que o Copiloto executa
```

Sem evidência confiável, a resposta sugerida diz isso explicitamente — nunca inventa compatibilidade nem confirma o que não pode confirmar (mesma regra da secao 5, "nunca inventar dado ausente").

**Base de Conhecimento Validada é consultada por ferramenta de SQL determinística, como qualquer outra ferramenta de consulta pontual — não é RAG.** Continua valendo a secao 6: sem embeddings, sem pgvector. Um item de conhecimento é um fato estruturado (`sku_id`, tipo, conteúdo, fonte, status `VALIDADO`/`SUGERIDO`/`REJEITADO`/`OBSOLETO`) gravado só com confirmação humana explícita — nunca o modelo "aprendendo sozinho" a partir de uma resposta anterior.

O contexto do Copiloto parte de um `support_case_id` autorizado e atravessa somente os vínculos declarados em `support_case_links`. Nunca usa `buyer_id`/`from/to` como fronteira de acesso nem consulta outra conta por coincidência de pedido, SKU ou texto. O texto sugerido e o texto final confirmado serão auditados em `support_reply_attempts`; tentativa falha não vira mensagem outbound fictícia (D-084).
