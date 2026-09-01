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
| **HEAD conhecido** | `44d3f54` (D-180) — esta fatia, D-181, é o commit seguinte |
| **Deploy no ar** | `fc39c27` (`worker-00044-ps5` / `api-00029-vkg`) — **20 commits atrás** |
| **Supabase Dev** | `nmgccyqquwxecqffsidr` (`speedbikers-gestao-v3-dev`) |
| **Migrations** | 117 locais == 117 no Dev, última `20260901141107` — sem drift |
| **Frente atual** | Trilha 8B — Performance, Segurança, Confiabilidade e Contexto |

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
| **P0-E** | `SECURITY DEFINER` / `search_path` / policies duplicadas | apontado pelos advisors; inventário ainda não feito |
| ~~P0-F~~ | ~~`get_stock_balances`~~ | ✅ corrigido em D-181 — **9.104 ms → 681 ms**, sem tocar na RPC |
| ~~P0-G~~ | ~~`get_listings_dashboard`~~ | ✅ corrigido em D-181 — **timeout em 60 s → 271 ms**, sem tocar na RPC |
| **P0-H** | Demais RPCs fora do budget | resta `get_sku_sales_baseline`, `get_sku_timeline` e a Central de Notificações — quatro das suspeitas entraram no budget junto com D-181 |

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

1. **P0-E** — inventário de `SECURITY DEFINER`, `search_path` das funções de
   trigger e policies permissivas duplicadas. É o último P0 de segurança
   ainda aberto.
2. **P0-H** — sobraram `get_sku_sales_baseline`, `get_sku_timeline` e as
   consultas da Central de Notificações. Reproduzir cada uma antes de
   otimizar: `pg_stat_statements` mistura versões antigas das funções.
3. **P1** — round trips por tela, retenção de `job_runs`, read models de
   `stock_movements` e triagem de índices, na ordem registrada na trilha 8B.

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
