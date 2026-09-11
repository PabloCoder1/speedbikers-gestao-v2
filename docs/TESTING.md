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

**Armadilha conhecida (2026-09-10):** a suíte de e2e assume que a `api` NÃO está no ar. `copiloto.spec.ts` afirma a mensagem de falha de conexão — é o comportamento correto quando só o `web` sobe, e é assim que a esteira roda. Com uma `api` local ligada na porta que `NEXT_PUBLIC_API_URL` aponta, a chamada passa a responder outra coisa e o caso fica vermelho **sem que nada tenha quebrado**. Antes de investigar um vermelho ali, confira se sobrou `api` rodando da sessão anterior. **E matar o processo da porta 8080 NÃO basta** (D-310): `pnpm --filter @sb/api run dev` roda com watcher, e ele ressuscita a api na próxima escrita de arquivo — foi assim que `saude.spec.ts` (a célula da API, que espera "sem resposta") reprovou depois de a api ter sido morta. Mata-se a TAREFA de fundo, e só então se confere a porta.

**Armadilha conhecida (2026-09-11):** a suíte de INTEGRAÇÃO **não é idempotente**. Rodá-la duas vezes no mesmo banco reprova ~15 casos, e o vermelho aponta para o lugar errado — três deles são de isolamento entre organizações ("usuário de outra organização não enxerga nenhum": esperava 0, viu 1), o que se lê como falha de RLS e é resíduo dos fixtures da rodada anterior. A ordem que conta é `db reset` + UMA rodada (D-312).

**Armadilha conhecida (2026-09-11):** depois de `supabase db reset`, o **PostgREST continua com o schema cache VELHO**, e a primeira coisa que fala com ele morre com `PGRST205: Could not find the table 'public.organizations' in the schema cache`. Lê-se como migration quebrada e não é — as tabelas estão lá, medido com `psql` no mesmo instante. Quem bate nisso primeiro é `e2e/seed.ts`, que escreve por PostgREST; a suíte de integração não vê nada, porque fala `pg` direto. Se o seed morrer assim, a suíte inteira roda contra um banco VAZIO e produz ~59 vermelhos que apontam para todo lado menos para a causa. A saída é recarregar o cache antes de semear (D-315):

```bash
docker exec supabase_db_<projeto> psql -U postgres -d postgres -c "notify pgrst, 'reload schema';"
docker restart supabase_rest_<projeto>
```

Não acontece toda vez: depende de o seed começar antes de o `reset` ter avisado o PostgREST. É corrida, então a ausência do erro numa rodada não prova que ele não vai aparecer na próxima.

**Armadilha conhecida (2026-09-10):** rodar a suíte de INTEGRAÇÃO deixa o Auth local quebrado até o próximo `db reset`. Os fixtures de RLS inserem em `auth.users` por SQL, e `confirmation_token` nasce **NULO** — o GoTrue lê aquela coluna como `string` e responde **500** em `GET /admin/users` (`"converting NULL to string is unsupported"`) para a listagem INTEIRA, não só para a linha ruim. Quem depende de `auth.admin.listUsers` para de funcionar: `e2e/seed.ts` (que procura o usuário pelo e-mail) e o convite de D-296. A ordem segura é **integração e e2e nunca compartilharem o mesmo banco sem reset entre elas**. E a lição vale além do teste: **linha de `auth.users` criada por SQL envenena a listagem do projeto todo** — quem criar usuário fora do GoTrue precisa gravar `''`, não `NULL`.

**Armadilha conhecida (2026-09-11):** o Playwright sobe `pnpm run start`, que serve o `.next` **ja construido** -- e com `reuseExistingServer` fora do CI. Editar a tela e rodar a suite na sequencia testa o BUILD ANTERIOR: a assercao nova fica vermelha e o codigo esta certo. Aconteceu em D-309 com duas assercoes (uma cor e um paragrafo novos). Depois de mexer em `app/`, `components/` ou `lib/`, a ordem e `pnpm build` **antes** de `playwright test` -- e derrubar o `next start` que sobrou, senao o reuso serve o build velho mesmo apos o build novo.

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
