# Handoff V3 — estado corrente

> **Este documento é só o AGORA.** História não mora aqui: está em
> `docs/archive/handoffs/`, em `docs/DECISIONS.md` (por `D-xxx`) e no git.
> Se você veio parar aqui procurando "o que aconteceu na sessão tal",
> procure lá. Regra de D-177: quem lê este arquivo precisa saber onde o
> projeto está, não como chegou.

---

## Estado

| | |
|---|---|
| **Atualizado em** | 2026-09-01 |
| **Branch** | `v3` (a `main` é a V2, só referência — nunca copiar) |
| **HEAD conhecido** | `05d0d35` (D-191) — esta fatia, D-192, é o commit seguinte |
| **Deploy no ar** | `fc39c27` (`worker-00044-ps5` / `api-00029-vkg`) — **33 commits atrás** |
| **Supabase Dev** | `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) |
| **Migrations** | 119 locais == 119 no Dev, última `20260901160650` — sem drift |
| **Frente atual** | Trilha 8B — P0 fechado (A–H); em P1 |

### O que está pronto

Fases 0–4, 5A–5D, 6, 6B, 7, 7B e 9 (backend) concluídas nos critérios
registrados. A trilha 5E entregou as seis centrais analíticas
(Movimentações, Dashboard 360º do Anúncio, abas do SKU, Preços, Full,
Fornecedor). A 8A entregou Usuários/Permissões (D-175) e Saúde do
Sistema (D-176); faltam Integrações e Configurações.

Detalhe por fase: `docs/ROADMAP.md`. Motivo de cada decisão:
`docs/DECISIONS_INDEX.md` → `D-xxx` em `docs/DECISIONS.md`.

---

## P0 ativos (trilha 8B)

Medidos contra o Dev em 2026-09-01, não herdados de documentação.

| | Item | Evidência |
|---|---|---|
| ~~P0-A~~ | ~~Contexto dos agentes~~ | ✅ corrigido em D-177 — bootstrap de ~1.245 KB para **7,6 KB**; `pnpm docs:check` guarda |
| ~~P0-B~~ | ~~Writes sem verificação~~ | ✅ corrigido em D-178 — `assertWritten` aborta; 3 testes provam que nada posterior roda |
| ~~P0-C~~ | ~~Webhooks sem consumidor viram task~~ | ✅ corrigido em D-179 — allowlist em `@sb/contracts`; **218.750 execuções/zero trabalho** deixam de ser enfileiradas ⚠️ só vale após o deploy |
| ~~P0-D~~ | ~~`has_role` sem organização~~ | ✅ corrigido em D-180 — `has_org_role` em 21 policies e 8 funções; `has_role` removido; +5 testes cross-org |
| ~~P0-E~~ | ~~`SECURITY DEFINER` / `search_path` / policies duplicadas~~ | ✅ inventariado em D-182 — **nenhum dos três tinha vulnerabilidade**; advisor 33 → 26 WARN; allowlist das 25 RPCs virou teste de CI |
| ~~P0-F~~ | ~~`get_stock_balances`~~ | ✅ corrigido em D-181 — **9.104 ms → 681 ms**, sem tocar na RPC |
| ~~P0-G~~ | ~~`get_listings_dashboard`~~ | ✅ corrigido em D-181 — **timeout em 60 s → 271 ms**, sem tocar na RPC |
| ~~P0-H~~ | ~~Demais RPCs fora do budget~~ | ✅ fechado em D-183 — `get_sku_sales_baseline` **1.334 ms → 49 ms**; `get_sku_timeline` nunca foi problema (3.308 ms era cache frio, o real é 57 ms); a Central de Notificações não estava lenta, estava **contando errado** |

**Todo o P0 da trilha 8B fechou** — A a H. A frente passa para o P1.

Números completos e método: `docs/PERFORMANCE.md`.

---

## Riscos ativos

- **O que está no ar é velho.** O deploy é de `fc39c27`; D-171 (que corrige
  o 429 das visitas) e D-176 (`APP_COMMIT` no `/health`) **não estão
  valendo**. Até o próximo deploy, `/saude` mostra `UNKNOWN` — corretamente.
- **Relist nunca foi exercitado contra o ML real.** A primeira execução
  precisa ser ensaio humano deliberado, com anúncio sacrificável.
- **A suíte de integração local exige banco recriado.** `supabase db reset`
  antes de rodar; e rodá-la quebra o seed do Playwright depois (usuários
  criados por SQL deixam `confirmation_token` nulo e o GoTrue estoura).
- **2 pedidos estão sem linha em `order_items`** (`2000017347483988` e
  `2000017394032682`): `paid`, com o movimento de estoque gravado e nenhum
  item. A dedução está certa; falta a linha que `claim-return` precisa para
  reverter devolução — sem ela ele registra `claim_return_order_item_not_found`
  e pula. **Os dois caminhos que produzem esse estado estão fechados** (D-184
  tirou a leitura da janela, D-189 tirou a janela e parou de apagar itens a
  partir de resposta vazia); qual dos dois aconteceu não dá para saber.
  **Reprocessar os dois continua sendo ato pendente.**
- **O tipo gerado não conhece a RLS.** `supabase gen types` deriva a
  nulabilidade de um embed da chave estrangeira; a RLS é avaliada depois, e
  uma linha invisível ao chamador faz o embed voltar `null` numa coluna que o
  tipo declara não-nula (medido em D-192). Não remova um `?.` sobre embed só
  porque o compilador diz que é desnecessário — pergunte antes se a RLS pode
  esconder aquela linha daquele leitor.
- **A primeira medição pode ser cache frio.** `get_sku_timeline` mediu
  3.308 ms na primeira passada e **57 ms** na segunda — quase virou uma
  otimização inútil. Sempre duas passadas seguidas; se divergirem muito, a
  primeira era I/O de disco (D-183).
- **`n_live_tup` mente, e mentiu feio.** As estatísticas do Dev estão velhas:
  `job_runs` estimava ~6 mil e tem **271.184**; `ml_credentials` estimava 0 e
  tem **4 credenciais reais**. Para qualquer raciocínio de segurança ou de
  volume, `count(*)` — nunca a estimativa (D-182).

---

## Atos humanos pendentes

Nada disto pode ser feito por um agente.

1. **Deploy** dos dois serviços (`bash infra/deploy-cloud-run.sh`) — leva ao
   ar D-162→D-179: a correção do 429, o `APP_COMMIT` e o fim dos 218.750
   jobs vazios de webhook. **É o ato de maior efeito pendente.** (D-180 e
   D-181 são de banco e já valem no Dev, sem depender do deploy.)
2. `bash infra/cloud-scheduler.sh` depois do deploy (15 jobs esperados).
3. Relatar **Dashboard → Database → Backups** do projeto Dev (decide a
   abordagem de backup da Fase 8).
4. Ensaio de `/produtos` (5 SKUs sentinela) e preencher
   `/reposicao/configuracoes`.
5. Primeiro relist real, deliberado, com anúncio sacrificável.
6. **Auth → Leaked Password Protection** está desligado no Supabase
   (configuração externa, não migration).
7. **Branch protection da `v3`**: hoje `protected: false` — a CI não é
   tecnicamente obrigatória para merge.

---

## Próximos passos

1. **O deploy é o que trava a medição, e agora com peso.** **Seis** fatias
   seguidas (D-184 a D-190) mudaram o worker e **nenhuma pôde ser medida
   ponta a ponta**. O caminho de pedidos saiu de 7 idas ao banco por pedido
   para ~0,16 — na estrutura, fixada em teste. O número real precisa do
   deploy, e a consulta está em `docs/PERFORMANCE.md`.

   **O caminho de pedidos fechou como frente.** O que resta do P1 é outro
   assunto.
2. **P1 — retenção de `job_runs`, e ela também espera o deploy.** São
   **271.184 linhas** reais. Bloqueado por regra própria — "só depois de
   reduzir a origem", e a origem (218.750 jobs vazios de webhook, D-179) só
   some com o deploy. Junto com o item 1, é o segundo do P1 travado pelo
   mesmo ato humano.
3. **P1 — round trips por tela e read models**, os dois itens do P1 que
   sobraram e não dependem do deploy. `docs/ROADMAP.md` tem a ordem.
4. **Antes da segunda organização** — `get_system_health` tem escopo de
   plataforma com guard de tenant (D-182). Não é urgente hoje e não tem
   correção óbvia: as duas tentativas naturais causam regressão verificada.

---

## Onde procurar o resto

| Preciso de… | Leia |
|---|---|
| fases, itens abertos, Definition of Done | `docs/ROADMAP.md` |
| por que uma decisão foi tomada | `docs/DECISIONS_INDEX.md` → `D-xxx` |
| benchmarks, antes/depois, planos | `docs/PERFORMANCE.md` |
| história de sessões anteriores | `docs/archive/handoffs/` |
| banco, RLS, tabelas | `docs/DATABASE.md` |
| API do Mercado Livre | `docs/MERCADO_LIVRE.md` |
| métricas canônicas | `docs/METRICS.md` |
