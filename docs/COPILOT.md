# Copiloto Speed Bikers

> Dono documental de: arquitetura do assistente, registro de ferramentas, guardrails e uso de IA.
> Status: **estratégia aprovada.** Implementação na Fase 7.

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

Ferramenta dedicada. **O texto original do usuário é preservado íntegro**, em coluna separada da versão estruturada.

A IA gera, quando possível: título, problema, objetivo, usuários impactados, fluxo sugerido, benefício esperado, critérios de aceite, dependências e riscos aparentes, complexidade a avaliar, autor e data.

*Motivo de preservar o original:* a estruturação pode errar a intenção. Quando a sugestão for lida três semanas depois, o que o usuário realmente escreveu é a única fonte confiável. Sobrescrever perde informação de forma irreversível.

Estados na Central de Sugestões: `nova` -> `em_analise` -> `aprovada` -> `planejada` -> `em_desenvolvimento` -> `entregue` -> `recusada`.

---

## 9. Custo e transporte

- Streaming SSE a partir de `apps/api`.
- Chamadas de IA são rastreáveis e, quando pesadas, assíncronas.
- **A interface nunca dispara chamada de IA no carregamento da página.** A V2 precisou de um teste dedicado para garantir isso, e a ideia vale ser mantida.
- Modelo e limites de custo são configuráveis por organização.

---

## 10. Pendências

- Escolha do modelo e orçamento de custo por período.
- As primeiras ferramentas acompanham a tela âncora, o Dashboard de vendas Geral e por Conta (D-033): vendas por período, comparação entre períodos e comparação entre contas.

---

## 11. Sugestão de resposta de atendimento (Fase 7B, conceitual)

> Registrado em 2026-08-24 (D-071), junto com a Central de Atendimento/SAC — `docs/PRODUCT_REQUIREMENTS.md`, `docs/ROADMAP.md` Fase 7B. Nada aqui está implementado.

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
