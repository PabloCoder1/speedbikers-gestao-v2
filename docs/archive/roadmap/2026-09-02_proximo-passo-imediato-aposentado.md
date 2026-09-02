# "Próximo passo imediato" do ROADMAP — aposentada em 2026-09-02

> Seção retirada de `docs/ROADMAP.md` em D-215 por ser um **segundo dono** da
> pergunta que o `docs/HANDOFF.md` responde desde D-177. Divergiu, como dois
> donos do mesmo fato sempre divergem: mandava abrir a Fase 9 pelo preflight,
> concluído em D-162/D-164.
>
> Texto integral abaixo, sem edição, porque ele carrega registro histórico
> (o que a seção dizia em D-120 e em D-155) que não está em outro lugar.

## Próximo passo imediato

> Reescrito em 2026-08-31 (D-155). A versão anterior tinha parado em D-134/D-135, apontando como "próximo passo" a agregação de ruído (resolvida por outro caminho em D-135) e a abertura da 5C — as Fases 5C, 5D e 6B fecharam inteiras desde então. **Esta seção é a que mais envelhece no repositório: reescrevê-la é parte de fechar qualquer etapa, não uma tarefa separada.**

**Fase 6B COMPLETA (D-152→D-155).** Da fila declarada por D-120 (`4B → 5C → 5D → 6B → 9`), resta a **Fase 9** (republicação oficial de anúncio — a primeira escrita destrutiva no ML), com a **Fase 8 intercalável** (backup/restore verificado é o único risco que cresce a cada dia de uso real).

**Antes de abrir a Fase 9, os dois interruptores HUMANOS da 5D seguem desligados** — e são atos do usuário por decisão registrada (D-127/D-144), não do agente:

1. 🟡 **O ensaio operacional de `/produtos`** (D-133): marcar os 5 SKUs candidatos já separados no HANDOFF, conferir em `/cobertura` (devem sair com cobertura VAZIA e rótulo "estoque virtual"), só então o lote grande (~1.089 SKUs com assinatura sentinela). Sem isso, valor de estoque (D-139) e a qualidade da sugestão de compra seguem bloqueados.
2. 🟡 **Preencher `/reposicao/configuracoes`** (D-144): sem configuração, `/reposicao` recusa para todos — é o contrato.

**Decisão de produto pendente sinalizada desde D-135**: `listing.available_quantity.changed` é 91% das notificações (informativo, legítimo) — silenciar, agregar ou manter é escolha do usuário.

~~O **rate limit de `visits`** (85% de falha 429, medido em D-143)~~ — **corrigido em 2026-08-31 (D-156)**: checkpoint pela própria `daily_listing_visits` (cada tentativa soma progresso em vez de recomeçar; o teto de 8 tentativas da fila deixou de arriscar a cauda), espaçamento de 150 ms entre chamadas e enumeração paginada (a 8ª ocorrência da classe D-131, ainda latente: 857 ativos medidos contra o teto de 1.000). **Aguarda deploy do worker e a leitura da rodada seguinte** (regra de D-109 — a confirmação é a queda das ~22 execuções falhas/dia).

~~O item de **Vendas** do PRD que restou da 5C~~ — **seis das sete métricas entregues em 2026-08-31 (D-157 + D-158, visão "hoje" incluída)**; resta só a margem operacional, bloqueada pela persistência de frete/desconto.

~~Abrir a **Fase 9** pela modelagem pai→filho~~ — **aberta em 2026-08-31 (D-159)**: modelo, máquina de estados e idempotência por constraint entregues. **A próxima fatia da Fase 9 é o preflight** (nunca fechar o pai quando pré-condição crítica falha: tag `relist` já presente, Full, catálogo — os bloqueios que a pesquisa mandou impor).

**Outras candidatas**: a **Fase 8** (a metade do DADO do backup espera o relato do Dashboard — ver o item da fase); A margem operacional fechou em D-166 — **o item de Vendas e a Fase 5C estão 100% completos**.

**Registro histórico do que esta seção dizia antes (D-120):**

**Fase 7B COMPLETA (D-116)** e o Copiloto fechado (D-114). Depois disso, quatro etapas:

- **D-117** — dois defeitos P0 achados por auditoria: a Central de Ações quebraria inteira na primeira ação de SAC (`evidence` tem duas formas, a tela lia uma, sem consultar `kind`), e o envio de resposta não checava a CONTA. `private.has_role` sem escopo de organização ficou registrado, não corrigido: 32 sítios, e a verificação adversarial refutou a exploração hoje (1 organização, medido).
- **D-118** — a CI vermelha de D-117 expôs dois defeitos latentes que não eram dela: `knowledge_entries` repetindo o `on delete set null` que D-099 tinha acabado de eliminar, e um teste de escopo que **nasceu impossível de passar** (pedia zero onde a fixture garante 1 desde D-085), o que corrige o registro de D-115.
- **D-119** — vinculação manual livre, o item P1 mais antigo aberto. A revisão adversarial achou 16 defeitos no código recém-escrito, três decisivos — entre eles a feature nascendo MORTA em qualquer organização com 2+ membros.
- **D-120** — os trinta blocos de features do usuário viraram roadmap, depois de auditoria: cinco subfases novas (4B, 5C, 5D, 6B, 9), sem renumerar nada.

**O próximo passo é a Fase 4B**, e não por preferência: a auditoria mediu que 80% das features pedidas leem SKU, vínculo ou saldo local, e os três estão incompletos ou contaminados. O primeiro item é **enumerar o catálogo real do vendedor** — hoje a V3 não sabe quais anúncios existem.

~~**Duas questões de negócio ABERTAS bloqueiam parte da fila** (D-120)~~ — **ambas respondidas pelo usuário em 2026-08-28.** (1) O estoque sentinela **é o estado real do UpSeller, é estoque virtual** deliberado → D-127. (2) "Importado" é **rota de compra por fornecedor**, não origem fiscal → confirmado com número em D-129: `origin_code` da NF-e contradiz a regra em **707 SKUs** e por isso **não serve** como fonte de Nacional/Importado; o eixo é `supplier_brand`.

**Pendências operacionais:** ~~deploy do `apps/api`~~ — feito em 2026-08-28 (`api-00027-lsp`), junto do worker (`worker-00041-x4q`, D-121). Sobre a **CI**: D-130 mediu que ela estava **vermelha desde 2026-08-27** — o teste-guarda de GRANTs de D-098 nunca passou, e como ele só roda na CI (`test` exclui `*.integration.test.ts`), seis commits foram entregues lendo "check 29/29" como se fosse verde. As duas causas foram corrigidas na migration `20260828200541` e as consultas dos testes devolvem zero linhas contra o banco real; **falta a confirmação pela própria CI** (repositório privado, sem token na sessão). 🔴 **Achado de D-132 que vira pendência própria: não existe job de import do ERP.** `erp_stock_snapshots` tem **um único dia** (2026-08-21) e `infra/cloud-scheduler.sh` tem 13 jobs `v3-*`, nenhum de import. O alvo rolado para a frente (D-132) faz o saldo parar de ser apagado, mas ele só melhora quando a planilha do UpSeller for reimportada — quanto mais velho o retrato, mais a V3 depende do próprio ledger. Decidir entre reimportação manual periódica e job próprio é questão em aberto. Seguem abertas: e o **primeiro envio real de resposta** a um comprador (🟡, ato irreversível que deve ser humano e deliberado).
