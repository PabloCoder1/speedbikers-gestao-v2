# Decisão de arquitetura do banco: comparação de cenários

> Database Sentinel, 17/11/2026. **Proposta para o dono decidir**; ainda não
> virou `D-xxx`. Preços conferidos em 17/11/2026: Supabase pela documentação
> oficial (`billing-on-supabase`, `billing-faq`, `database-size`), Neon por
> fontes de 2026 que citam a página de preços. **Confirmar os do Neon na
> página oficial antes de contratar.**

## 1. Fatos que decidem

| Fato | Evidência |
|---|---|
| Banco restaurado: 1.092 MB, sem *bloat* | [SIZE_REPORT.md](SIZE_REPORT.md) §1 |
| Só os dados de negócio: ~520 MB | SIZE_REPORT §2 |
| Crescimento: ~420 MB/mês hoje, ~110–150 MB/mês com o plano de otimização | SIZE_REPORT §4, OPTIMIZATION_PLAN §3 |
| Supabase Free: banco acima de **500 MB entra em modo somente leitura** | docs `platform/database-size` |
| Free: pausa por inatividade de 7 dias; 90 dias para retomar um pausado; 2 projetos ativos; 5 GB de egress; 1 GB de Storage; sem backup diário | docs `free-project-pausing`, `billing-on-supabase` |
| Pro: US$ 25/mês com US$ 10 de crédito de compute (cobre 1 projeto Micro), 8 GB de disco, sem pausa, backup diário | docs `billing-faq` |
| Neon Launch: sem mensalidade; ~US$ 0,106 por CU-hora e ~US$ 0,35 por GB-mês | fontes de 2026; confirmar |
| A organização Supabase **Neurix já está no plano Free**, e produção e Dev estão `INACTIVE` | MCP `get_organization`, `list_projects`, 17/11 |
| A organização Neon **Neurix (Launch)** tem 7 projetos, nenhum do Speed Bikers | MCP Neon `list_projects`, 17/11 |
| O código depende da plataforma Supabase: 128 usos de `auth.uid()` nas migrations, RLS em todas as tabelas, PostgREST pelo `supabase-js` na web, api e worker, Realtime em `notification_recipients` e `support_cases`, Storage para avatares | `git grep` em `codex/sentinel-audit` |

## 2. Cenários

### A — Tudo no Supabase Free

**Inviável.** Os dados de negócio sozinhos (~520 MB) já passam da cota, sem
contar índices futuros, telemetria e *bloat*. O banco ficaria em modo
somente leitura no primeiro dia: a importação não chega a terminar, ou
termina e o worker falha em toda escrita. Sem a retenção seria pior: com
~420 MB/mês, mesmo um banco vazio sairia da cota em ~5 semanas.

### B — Supabase Free (operacional) + Neon Launch (histórico)

**Inviável na forma pedida, e arriscado em qualquer forma.**

- O "histórico" de negócio não é separável: faturamento, margens, curva
  ABC, comparativos de período e reposição leem 12 meses de `orders`,
  `order_items`, `ml_sales_lines` e `daily_*_metrics`, com *joins* a `skus`,
  `listings` e permissões por conta (`private.accessible_accounts()`). Partir
  por idade obrigaria cada RPC a consultar dois bancos, sem *join* nem RLS
  entre eles.
- O que É separável (telemetria, `domain_events` antigos, payloads crus) se
  resolve mais barato com retenção e arquivo frio do que com um segundo banco.
- Mesmo com todo o separável fora, o operacional quente (pedidos de 12 meses,
  estoque, SAC, cadastro) passa de 500 MB.
- Duas fontes de verdade, sincronização e recuperação em dois lugares: o
  risco que o próprio pedido manda evitar.

### C — Neon Launch como banco principal (Supabase Free só para Auth e Storage)

**Tecnicamente possível, caro em engenharia e economicamente empatado.**

Compatibilidade:

| Peça | No Neon | Esforço |
|---|---|---|
| Postgres 17, `pgcrypto`, `pg_trgm` | Sim | Baixo |
| `pg_cron` (vigia, conciliação, retenção) | Conferir a disponibilidade no plano Launch | **Desconhecido** |
| Supabase Vault (credenciais cifradas do ML, Shopee e TikTok) | Não existe | Médio: trocar por `pgsodium`/chave externa e migrar os segredos |
| RLS com `auth.uid()` (128 usos) | A função não existe; é possível criar um *shim* que lê `request.jwt.claims` | Médio, mas toca todas as políticas |
| PostgREST (`supabase-js` `.from()`/`.rpc()` em web, api e worker) | Neon Data API (baseada em PostgREST) com JWKS de um provedor externo | **Alto**: configuração, papéis `anon`/`authenticated`/`service_role`, limites de linha, `Prefer` headers e o comportamento de erro precisam ser reprovados um a um |
| Supabase Auth | Fica no Supabase Free, como emissor do JWT (chaves assimétricas/JWKS) | Médio. O projeto Supabase continua existindo, então a pausa por inatividade passa a ser um risco: o Auth seria pouco usado |
| Realtime (toasts de notificação, atualização do SAC) | Não existe | Trocar por *polling* ou outro serviço |
| Storage (2 avatares) | Fica no Supabase | Baixo |
| Migrations e CI (`supabase start`, `db reset`, `gen:types` pelo MCP) | Pipeline novo | Alto |

Custo mensal estimado (o worker escreve o tempo todo: webhooks, sincronização
a cada poucos minutos, `pg_cron`; o compute praticamente não dorme):

| Compute | CU-h/mês | US$/mês |
|---|---:|---:|
| 0,25 CU fixo (~1 GB de RAM, como o Micro do Supabase) | ~183 | ~19 |
| 0,25–0,5 CU com autoscale | ~183–365 | ~19–39 |
| 1 CU | ~730 | ~77 |
| Armazenamento (~1–2 GB + histórico) | | ~0,5–1 |

O Launch "já contratado" **não tem mensalidade a amortizar**: o Speed Bikers
seria consumo novo na mesma fatura. Esforço estimado: **3 a 6 semanas** de
engenharia, mais regressão completa (RLS, e2e, integrações). Risco alto de
regressão silenciosa de autorização.

### D — Supabase Pro só para a produção (fora do pedido; incluído por ser o termo de comparação)

- US$ 25/mês. O crédito de US$ 10 cobre o compute Micro de **um** projeto.
  8 GB de disco, sem pausa, backup diário, mesma arquitetura.
- O Dev fica numa organização Free (pausado, ou retomado só quando preciso).
  Ele não pode dividir a organização paga: cada projeto a mais custa ~US$ 10.
- Zero mudança de código. O plano de otimização mantém o disco abaixo de
  8 GB por ~4 anos no ritmo projetado.

## 3. Comparação

| | A Free | B Free + Neon | C Neon principal | D Pro (só prod) |
|---|---|---|---|---|
| Cabe? | **Não** (≥ 1,09 GB contra 500 MB) | **Não** (quente > 500 MB) | Sim | Sim (8 GB) |
| Custo/mês | US$ 0, mas somente leitura | US$ 0 + Neon ~US$ 19+ | **~US$ 19–39** | **US$ 25** |
| Engenharia | — | Alta (dois bancos por RPC) | Alta (3–6 semanas) | Nenhuma |
| Risco | Parada | Divergência, duas verdades | Autorização (RLS/JWT), Realtime, Vault, CI | Baixo |
| Performance | — | Pior (rede entre bancos) | Partida a frio se dormir; igual se não dormir | Atual |
| Manutenção | — | Duas plataformas | Duas plataformas (Neon + Supabase Auth) | Uma |

## 4. Recomendação

**D, com o plano de otimização.** É o mais seguro e, para este volume, o
mais econômico em custo total. A economia de C sobre D é de **US$ 0 a 6 por
mês** no melhor caso, e paga semanas de reescrita e um risco real de
autorização. A e B foram descartados pela medição, e não por preferência.

Rever C se uma destas mudar: (1) o compute do Supabase precisar subir de
Micro (US$ 15 a mais por mês no Small); (2) a carga de escrita do worker
puder dormir (o Neon cobraria horas, não o mês); (3) o Supabase mudar preço
ou cota.

**Antes de tudo, a urgência:** a produção está pausada (ASSESSMENT §3).
Retomar numa organização Free põe um banco de mais de 1 GB em modo somente
leitura. A retomada segura é **na organização Pro**: transferir o projeto
para uma organização Pro antes de retomar, ou subir o plano da Neurix, que
neste caso leva o Dev junto e pede tirá-lo de lá. As duas são atos do dono,
com cobrança.
