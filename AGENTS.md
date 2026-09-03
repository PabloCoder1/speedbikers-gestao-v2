# AGENTS — Speed Bikers Gestão V3

Este arquivo é um **roteador de contexto**, não uma ordem para carregar o
repositório. Leia o mínimo que a sua tarefa exige (D-177).

## Sempre, antes de qualquer coisa

1. `docs/HANDOFF.md` — estado corrente, P0 ativos, riscos, próximo passo.
2. Confirme branch (`v3`), HEAD e que o Supabase é `nmgccyqquwxecqffsidr`.

Isso basta para saber onde o projeto está. **Não leia `DECISIONS.md`,
`ROADMAP.md` ou os arquivos de arquivo por padrão** — juntos passam de 1 MB
e a maior parte é irrelevante para qualquer tarefa específica.

## Depois, só o que a tarefa pede

| Tarefa | Leia também |
|---|---|
| Banco, RLS, migration, índice | `docs/DATABASE.md` |
| Mercado Livre, webhook, sync | `docs/MERCADO_LIVRE.md`, `docs/API.md` |
| Tela, componente, UX | `docs/PRODUCT_REQUIREMENTS.md` + a seção relevante do `docs/ROADMAP.md` |
| **Aparência** de tela ou componente | `docs/DESIGN_IMPLEMENTATION.md` — Design Contract e fila visual |
| Métrica, número exibido | `docs/METRICS.md` |
| Performance, benchmark | `docs/PERFORMANCE.md`, `docs/ARCHITECTURE.md` |
| Worker, fila, deploy | `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md` |
| Teste | `docs/TESTING.md` |

Para saber **por que** algo é como é: procure em `docs/DECISIONS_INDEX.md` o
`D-xxx` do assunto e leia **só aquela seção**:

```bash
grep -n "^## D-171" -A 40 docs/DECISIONS.md
```

## Regras que não mudam

- Toda mudança estrutural de banco é **migration versionada**, aplicada no
  Dev e renomeada para o timestamp que o MCP registrou.
- A `main` é a V2, **apenas referência** — nunca copiar código de lá.
- Agregação em SQL, nunca em JavaScript. Ausência de dado não vira zero.
- Nenhuma consulta que possa passar de 1.000 linhas sem paginação explícita,
  `readAllPages` ou agregação no SQL.
- Conversa anterior **não** é fonte de verdade. Código, migration e
  infraestrutura real prevalecem sobre qualquer texto.
- Antes de afirmar que algo está no ar: **verifique**. Commit não prova
  deploy; migration aplicada não prova worker atualizado.
- Trabalhe em fatias pequenas, teste antes de avançar e, ao fim de cada
  etapa, atualize `docs/HANDOFF.md` **sem transformá-lo em diário** — o
  histórico vai para `docs/archive/`, a decisão vira `D-xxx`, o benchmark
  vai para `docs/PERFORMANCE.md`.
- Secrets nunca no frontend nem no Git.

## Antes de commitar

```bash
pnpm run check && pnpm run build && pnpm docs:check
```
