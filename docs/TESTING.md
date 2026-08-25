# Estratégia de testes

> Dono documental de: camadas de teste, regras obrigatórias, ferramentas e portões de CI.
> Status: **estratégia aprovada.** Implementação a partir da Fase 1.

---

## 1. Camadas

| Camada | Ferramenta | Cobre | A partir de |
|---|---|---|---|
| **Unitário** | Vitest | `@sb/domain` puro: fórmulas de métrica, regras do ledger, sugestão de compra, motor de diff, severidade, confiança | Fase 1 |
| **Contrato** | Vitest + Zod | Parsing de respostas do Mercado Livre contra **fixtures gravados**; DTOs entre web e api | Fase 3 |
| **Integração** | Vitest + Supabase local | Migrations aplicam · **RLS permite e nega** · read models · **idempotência** | Fase 2 |
| **Equivalência** | Vitest | Fórmula em `@sb/domain` versus implementação SQL | Fase 5 |
| **E2E** | Playwright | Login, página do produto, conferência de NF-e, pedido de compra, Caixa de Entrada do SAC | Fase 5 |

**Nunca chamar o Mercado Livre ao vivo na CI.** Fixtures gravados, sempre.

---

## 2. As quatro regras não negociáveis

Cada uma foi extraída de um bug real e medido na V2.

### 1. Toda garantia de idempotência tem teste "rode duas vezes, espere um efeito"

Toda fila entrega ao menos uma vez. Um handler que não é idempotente vai duplicar dado — não é hipótese, é questão de tempo.

Alvos obrigatórios: persistência de pedido, aplicação de NF-e, movimento de ledger, emissão de evento, recálculo de métrica.

### 2. Todo policy de RLS tem teste negativo

Não basta provar que o usuário autorizado **vê**. É obrigatório provar que o usuário sem permissão **não vê**.

No Modelo A (D-012), o `web` lê o banco diretamente: a RLS **é** a segurança do sistema. Teste positivo sozinho não prova nada.

### 3. Toda fórmula duplicada em SQL tem teste de equivalência

*Motivo:* na V2, a sugestão de compra existia em SQL e em TypeScript. O `numeric` do Postgres virando `double` do JavaScript, seguido de `ceil`, produziu **25 divergências em 76 linhas** — sempre por exatamente uma unidade. Ambas as causas eram de representação numérica, não de fórmula. Depois das correções: zero divergências em 76 linhas.

Se a fórmula existe nos dois lugares, o teste compara os dois caminhos sobre uma amostra diversificada. Divergência quebra o build.

### 4. Toda rota pública nova tem teste negativo nas rotas vizinhas

*Motivo:* na V2, o proxy exigia sessão em tudo menos `/login`. O webhook do Mercado Livre não envia cookie, então o POST recebia 307 para `/login` e nunca chegava ao handler. Notificações de preço, promoção e Full **morriam em silêncio**, por semanas.

Ao liberar um caminho público, o teste prova que **apenas** aquele caminho foi liberado.

---

## 3. Ferramentas

**Vitest**, com descoberta automática de arquivos.

*Motivo:* a V2 usava `node --test` e acumulou **48 caminhos de teste listados à mão em uma única linha** do `package.json`. Isso não escala e garante que um arquivo novo seja esquecido.

**Supabase CLI local** para os testes de integração: banco real, migrations reais, policies reais. Testar RLS contra mock não prova nada.

**Playwright** a partir da Fase 5, apenas nos fluxos críticos. E2E amplo é caro de manter e frágil.

**Quando uma tela NOVA merece spec** (regra acrescentada em 2026-08-25, D-090): quando ela lê por um caminho que nenhum outro teste exercita. A Caixa de Entrada entrou porque o embed de `support_case_links` atravessa uma **FK composta** no PostgREST — comportamento de plataforma que não se prova por revisão de código. O gatilho para escrever a regra foi D-074/D-075/D-076, que fecharam três entregas seguidas com a mesma ressalva ("a tela não é visitada por nenhum spec"): a ressalva repetida virou sinal de que faltava critério, não de que faltava disciplina.

**Armadilha conhecida:** `expect(page.getByRole("alert")).toHaveCount(0)` NUNCA vale num app Next.js. O framework mantém um `#__next-route-announcer__` com `role="alert"` em toda página — live region que anuncia o título na navegação client-side. Para afirmar "não há erro na tela", asserte o TEXTO do banner.

---

## 4. Portões de CI

```text
typecheck -> lint -> unit -> integração -> build
```

Obrigatórios antes de qualquer merge na `v3`. Nenhum deploy sem CI verde.

---

## 5. Definition of Done

Complementa `docs/PROMPT_MASTER.md` §33. Uma feature só está pronta quando, conforme aplicável:

- requisito atendido e tipos corretos;
- lint sem erro relevante;
- testes unitários e de integração passando;
- build verde;
- segurança e permissões verificadas, com **teste negativo de RLS**;
- **idempotência testada** onde há reprocessamento;
- migrations verificadas, com índice justificado por consulta real;
- estados de loading, erro, vazio e stale implementados;
- performance considerada, com `EXPLAIN` das RPCs novas;
- documentação e `docs/HANDOFF.md` atualizados;
- commit lógico criado.

**Caminho feliz sozinho não é suficiente.**

---

## 6. O que não vamos construir

- Framework próprio de fixtures ou factories antes de haver repetição real.
- Cobertura mínima percentual como métrica de qualidade — cobre-se o que tem risco, não o que sobe o número.
- Testes de snapshot de interface, frágeis e de baixo sinal.
- Mock do Postgres. Integração usa banco real local.
