# Handoff multicanal

> Estado corrente da frente multicanal (Mercado Livre + Shopee), dividida entre
> o **Agente 1** (integração, backend, dados), o **Agente 2** (telas, filtros,
> dashboards) e o **Agente 3** (UX/UI, carregamento, design system). **Só o
> AGORA, sem diário** (como `docs/HANDOFF.md`): o porquê vira `D-xxx`; os
> contratos de dados detalhados estão em `docs/MULTICHANNEL_CONTRACTS.md`
> (Agente 1); a auditoria de telas e o modelo do filtro, em
> `docs/MULTICHANNEL_SCREENS.md` (Agente 2); o padrão de carregamento, a
> auditoria de UX e a fila, em `docs/UX_SYSTEM.md` (Agente 3).
>
> **Regras:** cada agente edita só a própria seção; as seções comuns mudam por
> acordo, com mensagem aos outros antes. Quem chega à `main` depois faz rebase,
> fica com o arquivo da `main` e reaplica só a própria seção. Contratos: `C-01…`
> do Agente 2 (consumo), `C-50…` do Agente 1 (dados). Decisões: Agente 1 nos
> ímpares e Agente 2 nos pares abaixo de D-500; Agente 3 de D-500 em diante.

---

## Estado

| | |
|---|---|
| Atualizado em | 2026-10-14 |
| `origin/main` | `2809d35f` (15/10: #172 e #179 do A1, D-453; #170, #171, #173, #175 e #177 do A2) |
| Branches abertas | A1: `feat/ip-fixo-nat` (#178: D-457, o IP fixo já aplicado) · A2: nenhuma (o #177 entrou) |
| Web em produção | `93304ac3` (merge na `main` publica) |
| Worker / api em produção | worker `worker-00047-mmw` (`11dbd5f4`) e api `api-00031-zhh` (`2809d35f`), 15/10, 100% do tráfego, saindo pelo IP fixo `34.95.145.35` (Cloud NAT, D-457; lista de IPs ligada na Shopee e conferida às 12:20); Shopee **sandbox**, Go Live em análise; push cadastrado, pushes de teste recusados na assinatura — diagnóstico no ar |
| Migrations em produção | até `20261015050000` (D-441 a D-451, run `38726738817`, 15/10) |
| Dev | todas as migrations da `main` (até `20261015050000`); serviços pausados (D-350) |
| Dado Shopee | 1 loja sandbox, 1 pedido, 1 item de catálogo; jobs horários sem falha em 7 dias. Nenhuma loja real |

---

## Agente 1 — backend/dados Shopee

**Concluído**
- Auditoria do estado real da Shopee e dos acoplamentos com o ML (14/10) — `docs/MULTICHANNEL_CONTRACTS.md` §1–§6.
- E0: D-430 em produção (migration e worker `562b1e60`, 14/10); o ciclo das 14:20 UTC terminou `done` com o worker novo.
- E1, E2 e E3 (D-432, D-433, D-435) **em produção** em 14/10: PRs #147/#148/#150 com CI verde (e2e inclusive), migrations pelo workflow com as duas aprovações do dono, worker e api em `93304ac3`. O vigia de D-418 foi agendado pelo dono (`vigiar-sincronizacao`, a cada 30 min) e agora cobre as lojas live.

**Em andamento**
- E4, vendas por marketplace e o consolidado (D-436): **em código e validada localmente** (integração com as 252 migrations do zero, equivalência com `get_sales_summary` e `get_shopee_sales_by_shop`, mutação do sandbox); PR #151 mergeado; migration `20261014210000` **em produção** em 14/10 (run `38597993424`; worker e api não mudam).
- E5, faturamento da Shopee (D-437): **em código e validada localmente** (integração com as 253 migrations do zero, equivalência do custo com `get_faturamento`, mutação do histórico de custo); PR #152 mergeado; migration `20261014220000` **em produção** em 14/10 (run `38597993424`).
- E6a, vendas por SKU entre marketplaces (D-439): **em código e validada localmente** (integração com as 254 migrations do zero, equivalências com `get_sku_sales_breakdown` e `get_shopee_sales_by_shop`, mutação do sandbox); PR #155 mergeado (`b3a58ac5`); migration `20261014230000` **em produção** em 14/10 (run `38612642381`).
- E6b, curva ABC por marketplace (D-441): **em código e validada** — o ML idêntico às funções antigas lado a lado (3.124 combinações locais e 11 casos no Dev com dados reais), ~30x mais rápida no Dev (plano custom), integração 976/976 com as 255 migrations do zero, 11 mutações; na `main` pelo #157 — falta a migration `20261015000000`.
- C-61, composição do faturamento da Shopee (D-443): **em código e validada** — o C-58 idêntico ao antigo lado a lado (200 verificações, com a cascata fechando, os dias somando o TOTAL e o por SKU coerente), o TOTAL de receita corrigido (achado do A2), o C-58 ~150x mais rápido (o custo por item era refeito para cada pedido), 9 mutações; na `main` pelo #160 — falta a migration `20261015010000`.
- E6c, `/produtos` com a Shopee (D-445): **em código e validada** — sem Shopee, idêntica à função antiga (25 combinações locais; 5 casos no Dev com 3.554 SKUs, ~75→78 ms); com Shopee, os campos do ML iguais, os números da Shopee iguais à contagem direta e as facetas fechando; 7 mutações; na `main` pelo #161 — falta a migration `20261015020000`. O ranking com resultado da central fica para depois do Go Live (D-430 §5).
- E7a, devoluções da Shopee (D-447): **em código e validada localmente** — a API `returns` conferida na documentação oficial; tabelas sem o comprador, situação como veio, SKU por item; job `shopee.returns.sync` encadeado pelo de pedidos; integração (4 testes) e 7 mutações; na `main` pelo #163 — falta a migration `20261015030000` e o deploy do worker; **a chamada real e a semântica de `page_no` se conferem no sandbox depois do deploy**. Cadência em `/saude`: `shopee.returns.sync` = 60 min, no #170 do A2.
- E7b, Ads da Shopee (D-449): **em código e validada localmente** — o desempenho diário dos anúncios CPC da loja conferido na documentação; `daily_shopee_ads_metrics` com a cobertura da leitura; job `shopee.ads.sync` (no máximo a cada 3 h); ROAS/ACOS/TACoS no SQL; integração (4 testes) e 8 mutações; na `main` pelo #166 — falta a migration `20261015040000` e o deploy do worker. **É o CPC da loja, não o total: o GMV Max de loja pode ficar de fora; não entra no resultado da venda até conferir com loja real.** Cadência em `/saude`: `shopee.ads.sync` = 180 min, no #170 do A2.
- E7c, repasse da Shopee (D-451): **em código e validada localmente** — `get_escrow_list` conferida na documentação (o extrato da carteira e o `get_income_detail` ficam para depois do sandbox: sem identificador e formato contraditório); `shopee_escrow_releases` com a cobertura; job `shopee.escrow-releases.sync`; integração (5 testes) e 15 mutações; na `main` pelo #169 — falta a migration `20261015050000` e o deploy do worker. Cadência em `/saude`: `shopee.escrow-releases.sync` = 60 min, no #170 do A2.
- E7d, push da Shopee (D-453): **em código e validado localmente** — o guia de push conferido; `POST /push/shopee` na api, assinado pelo corpo cru, antecipa `shopee.orders.sync` (código 3) e `shopee.returns.sync` (29) da loja, uma tarefa por janela de 5 minutos; sem assinatura válida, 200 e nada; autorização cancelada só no log (formato contraditório); 7 testes da rota e 7 mutações; sem migration; #172 — falta CI, merge, o deploy da **api** e o cadastro do endereço no Console (`docs/DEPLOYMENT.md` §6.2). Não muda contrato de leitura nem tela.

**Falta** (ordem proposta, `docs/MULTICHANNEL_CONTRACTS.md` §7)
- E7e em diante: o lote do financeiro (`get_escrow_detail_batch` — a referência segue contraditória: GET com corpo JSON, `response[]` × `escrow_detail_list`), o extrato da carteira e a renda por pedido — os três depois da resposta real do sandbox → E8 Go Live e estoque.

**Bloqueios**
- E4 e E5 em produção dependem do merge e da migration (dono). A exibição do resultado da E5 depende da decisão 1 abaixo (os três números já vêm prontos).

---

## Agente 2 — frontend multicanal

**Concluído**
- T0 — auditoria das telas e mapa de lacunas (14/10): `docs/MULTICHANNEL_SCREENS.md`.
- T1 — **na `main`, #149** (D-431): seletor de marketplace no início da barra de `/vendas`, `/vendas/shopee`, `/anuncios` e `/anuncios/shopee` (só com os dois canais; leva o período ou a busca, nunca conta, loja, marca ou estado); período personalizado em `/vendas/shopee`; `/contas` e o menu como "Contas e lojas"; os quatro jobs `shopee.*` com cadência horária em `/saude` (C-09). Só web; não depende de migration.
- T2 — **na `main`, #153** (D-434, consome o C-54): lojas Shopee por usuário em `/usuarios` — gaveta, coluna, histórico e convite que confere no banco o que concedeu. Pré-requisitos de banco e api conferidos em produção.
- T3a — **na `main`, #154** (D-438, consome o C-52 e os avisos de D-435): o aviso do vigia com nome e destino em notificações, a seção "Lojas Shopee" em `/sincronizacao` com os limiares do vigia (3 h e 12 h) e a autorização perto de vencer, e a contagem do rodapé por `marketplace_accounts`.
- Validação de cada etapa: `check`, `build`, `docs:check`, unitários e a suíte e2e inteira num stack isolado com o banco recriado do zero (210/210 na T3a; os 3 de convite só com o servidor na porta 3000).

- T4 — `/vendas` com "Todos os marketplaces" e "Shopee" na mesma tela (D-440, consome o C-53): faixa consolidada com o período anterior, várias contas por clique, gráfico de faturamento, unidades e compras e a tabela por marketplace e conta; `/vendas/shopee` vira o detalhe de pedidos e lojas. **Na `main`, #156** (`bcf33111`, deploy de produção da Vercel `success`).
- T5 — `/faturamento` com "Shopee" e "Todos" (D-442, consome o C-58): na Shopee, faixa com o período anterior, o resultado inteiro com o definitivo e o provisório ao lado, "da receita ao resultado", tabela por loja e a cobertura com os quatro motivos e onde se resolve; no "Todos", ML e Shopee lado a lado, **sem total de resultado**, com a receita somada a um clique em Vendas. **Na `main`, #158** (`8496b016`); a suíte e2e inteira passou localmente (219/219).
- T6a — o ranking de produtos no `/vendas` "Todos" e "Shopee" e a aba Vendas do SKU com o total entre marketplaces por conta e loja (D-444, consome o C-59), mais o selo "Teste" no painel Shopee do SKU (C-06). **Na `main`, #159** (`caafb616`, deploy de produção `success`), depois da migration `20261014230000` em produção (run `38612642381`).
- T3b — a Shopee nas telas de administração (D-446, consome o C-52): cartão em `/integracoes` (conexão pelo veredito de `/sincronizacao` e a autorização perto de vencer; sincronização pelos quatro jobs `shopee.*`) e a seção "Shopee" em `/configuracoes` (contagens no banco, na mesma ida da RPC); de carona, os cartões de `/integracoes` deixam de quebrar letra por letra no celular. **Na `main`, #162** (`558eacd1`). O seletor **continua** lendo `ml_accounts`/`shopee_shops`: a view calcularia a reconciliação de cada conta ML só para contar (D-446 §3).

- T-R5 — o cartão "Por loja" de `/vendas/shopee` no celular: as notas invadiam a célula vizinha (medido em 390 px: 134 a 222 px); só nesta tabela a célula quebra e a nota desce, e um e2e mede o transbordo. **Na `main`, #168.**
- As cadências de `/saude` para os jobs novos do A1: devoluções e repasse de hora em hora, Ads a cada 3 h (C-62, C-64, C-63). **Na `main`, #170.**
- T6c — `/produtos` com a Shopee (D-454, consome o C-56): com loja live, "só no ML", "só na Shopee" e "nos dois" nos filtros de anúncio e venda, os cartões de "sem anúncio/venda" em "nenhum marketplace" com o só do ML ao lado e a coluna de giro por marketplace, sem total. **Na `main`, #171.**
- T5c — os Ads CPC da loja no `/faturamento` da Shopee (D-456, consome o C-63): seção própria, rotulada "CPC da loja", fora do resultado e sem somar com o Mercado Ads. **Na `main`, #173.**
- T-R6 — leitura que falha deixa de aparecer como "nenhum" em `/usuarios`, `/vinculacoes`, `/compras/novo`, `/diagnostico` e no SKU (achado do A3, D-067). **Na `main`, #175.** A `/curva-abc` (as contas, as listas de marca e categoria e os filtros salvos; e o falso "não estão disponíveis para você" quando a leitura das contas falha) vem no PR da correção dela.
- T5b (D-452, C-61: a cascata do recebido, a série e os produtos), T5d (D-458, C-64: o repasse), T6b (D-448, C-60: a Curva ABC com "Todos" e "Shopee"), T6b2 (D-450: o Excel com o recorte) e as devoluções em `/vendas/shopee` (D-460, C-62, decisão do dono de 15/10). Cada uma validada com a suíte e2e inteira; entram juntas pelo **#177**, que encadeia o #164, o #165, o #167 e o #174 para um merge só (cada merge isolado reabria conflito no índice das decisões).

**Em andamento**
- Nada: o #177 (que levou o #164, o #165, o #167 e o #174) e o #176 do A3 (D-500) estão na `main` e em produção.

**Falta** (`docs/MULTICHANNEL_SCREENS.md` §8)
- A tela da demanda da Shopee na cobertura e na sugestão de compra (T-R3), sobre o C-65 do A1 — espera o dono liberar a mudança da decisão de 14/10.
- Os jobs novos (devoluções, Ads, repasse) no cartão Shopee de `/integracoes`, quando estiverem rodando em produção.
- T7 busca universal (C-57) → T8 central e meta (Go Live).

**Bloqueios**
- Tudo o que é Shopee só mostra números com loja **live**: hoje só há a sandbox. O Go Live do app é do dono (o Cloud NAT com IP fixo já está em produção, D-457).

**Achados para o dono e o A1**
- O parâmetro `canal` já é o tipo de caso em `/atendimento`: o filtro novo usa `marketplace`.
- O filtro de conta tem cinco convenções na URL (`account`/`conta` por slug, `conta`/`escopo` por uuid, `loja`); os filtros salvos guardam esses valores, então o slug antigo continua aceito na leitura.
- **T-R3 confirmado pelo dono (15/10):** a planilha do UpSeller já vem com a venda da Shopee descontada do estoque, e a reposição só conta a demanda do ML — cobertura alta demais e sugestão baixa demais para SKU que vende na Shopee. O A1 desenha o C-65 (a demanda da Shopee somada no SQL, em colunas separadas); falta o dono liberar a mudança da decisão de 14/10.
- C-63: o TOTAL soma o gasto e as vendas ignorando o dia nulo, e um dia sem o gasto infla o ROAS. A tela avisa pela série; o A1 corrige no SQL (D-455).
- C-58: o TOTAL vem com `receita_bruta` NULA quando as lojas somáveis não têm pedido no período, e a linha da loja vem 0 — a tela mostra "—" (não inventa o zero), mas o certo é o TOTAL dizer 0 quando há loja lida sem pedido. Pedido ao A1.
- e2e: rodar a suíte duas vezes no mesmo banco quebra `atendimento` e `notificacoes` (o seed não desfaz caso assumido nem notificação lida) — `db reset` entre rodadas.

---

## Agente 3 — UX/UI, carregamento e design system

Aberto em 14/10. Padrões, auditoria e fila em `docs/UX_SYSTEM.md`; decisões na faixa **D-500+** (combinada com A1 e A2). Território: componentes compartilhados de carregamento e estado (`carregando*.tsx`, `item-de-menu.tsx`, `formulario-filtro.tsx`, `filter-menu.tsx`, `filter-pill.tsx`, `kpi-strip.tsx`, `saved-filters.tsx`), o bloco CARREGAMENTO de `globals.css` e as telas sem branch aberta do A2. Não muda dado, consulta, parâmetro de URL nem regra de negócio.

**Concluído**
- Auditoria de carregamento, interação e estados especiais (14/10): 17 achados com evidência, `docs/UX_SYSTEM.md` §2.
- D-500, atualização no lugar: filtro, busca, paginação e aba na mesma tela mantêm o dado velho visível (barra da moldura, conteúdo esmaecido, `aria-busy`). As opções de menu de filtro e as visões salvas passam a ser navegação suave (antes: `<a>`, recarga do documento). A busca de `/estoque` usa o `FormularioFiltro`. Em `/estoque`, com 600 ms de latência: busca de 1.304 para 663 ms e menu de 1.268 para 926 ms.

**Em andamento**
- D-500 no **#176** (só web, sem migration): entra quando a CI fechar e o dono mergear.

**Falta** (`docs/UX_SYSTEM.md` §3)
- Atualização no lugar nos 45 `<Link>` sem indicador e nas 24 buscas GET restantes. Começa pelas telas sem branch do A2; `/anuncios`, `/vendas/shopee`, `/curva-abc`, `/faturamento` e `/produtos` só quando o A2 liberar.
- Botão pendente compartilhado e `EstadoDaTela` (erro, vazio e permissão).
- Shell num layout: proposta ao dono, depois de #164, #165 e #167.

**Para o A2**
- Falha de leitura mostrada como "nenhum" em `/vinculacoes`, `/usuarios` (histórico), `/curva-abc` (opções), `/compras/novo`, `/diagnostico` e `/skus/[skuId]` (`docs/UX_SYSTEM.md` §2, item 8). É lógica de tela, então fica com você; A3 dá a forma do estado de erro.
- Tela nova de filtro: use `ItemDeMenu`/`FilterMenu`, `FilterPill` e `FormularioFiltro`, e nunca `<a href="?…">` ou `<form method="get">`.

---

## Contratos combinados

| Id | O quê | Dono | Consumidor | Estado | Critério de aceite |
|---|---|---|---|---|---|
| C-01 | Seletor Marketplace/Conta em toda tela que filtra por conta; lojas em `/contas`, `/sincronizacao` e no shell | A2 | — | T3a na `main` (D-438); T3b em código (D-446); o seletor conta nas tabelas-base, pela mesma permissão | só lista o que a permissão deixa; slug antigo continua valendo |
| C-02 | `/vendas` e Home com "todos", "ml", "shopee" e várias contas | A2 | — | `/vendas` em código (T4, D-440); a Home ainda não | ML idêntico ao de hoje; a web não soma linha |
| C-03 | `/faturamento` com marketplace e a linha por loja | A2 | — | em código (T5, D-442) | componente não comparável nunca somado |
| C-04 | Ranking, curva ABC e aba Vendas do SKU com marketplace | A2 | — | ranking e aba Vendas em código (T6a, D-444); curva ABC aguarda o C-60 (T6b) | — |
| C-05 | Concessão de loja em `/usuarios` | A2 | — | rascunho #153 (T2, D-434) | usuário sem a loja não a vê em tela nenhuma |
| C-06 | Selo de loja de teste no painel Shopee do SKU | A2 | — | em código (T6a, D-444), sobre a C-55 | loja sandbox marcada "Teste" |
| C-07 | `/produtos` sem chamar de "sem anúncio/venda" o SKU que só a Shopee tem | A2 | — | **pedido novo ao A1**: `get_products_overview` com a Shopee (depois de E6) | — |
| C-08 | Busca universal achando loja, anúncio e pedido Shopee | A2 | — | **pedido novo ao A1**: `search_entities` com a Shopee | — |
| C-09 | `/saude` com veredito de atraso dos jobs `shopee.*` | A2 | — | em código (T1, D-431) | job horário atrasado aparece como atrasado |
| C-50 | Catálogo e vínculo Shopee: `get_shopee_listings`, `get_shopee_listings_summary`, `get_sku_shopee_listings`, `get_shopee_shop_catalog_counts`, `set_/remove_shopee_sku_link` | A1 | `/anuncios/shopee`, `/skus/[id]`, `/contas` | em produção | — (existente; §3.2) |
| C-51 | Vendas Shopee por loja: `get_shopee_sales_by_shop`, `get_shopee_orders` | A1 | `/vendas/shopee` | em produção (14/10) | migration em produção e a loja de teste na tela |
| C-52 | `marketplace_accounts`: a fonte única do seletor Marketplace/Conta, com `slug` do ML e `shop_id` da Shopee (colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.0); evento de loja `entity_type = 'shopee_shop'` com `shopee_shop_id` (rótulo e link na web: A2) | A1 | seletor do A2; notificações | em produção (D-435, 14/10) | uma linha por conta/loja visível ao usuário, respeitando a permissão por conta/loja |
| C-53 | `get_marketplace_sales_summary` (linhas TOTAL/MARKETPLACE/CONTA) + `get_marketplace_sales_daily` (`p_marketplaces text[]`, `p_account_ids uuid[]`); métricas `multicanal_*` (METRICS 5T) | A1 | `/vendas` (T4) | em produção (D-436, #151, 14/10) | só ML = números de hoje; linha consolidada no SQL; NULO no que não soma; sandbox fora |
| C-54 | Permissão por loja Shopee: `user_shopee_shop_permissions` (insert/delete direto sob RLS, só ADMIN, só para membro; como `user_account_permissions`), eventos `SHOPEE_SHOP_ACCESS_GRANTED`/`_REVOKED` (coluna `shopee_shop_id`), convite `POST /v1/organization/invites` com `shopeeShopIds` | A1 | tela de Usuários (A2, T2) | em produção (D-433, 14/10; api do convite em `api-00028-qmw`) | usuário sem a loja não lê nada dela, por tabela e por RPC — provado na integração |
| C-55 | `get_sku_shopee_listings` devolve `environment` da loja (atende C-06) | A1 | painel Shopee do SKU | em produção (D-432, 14/10); coluna `environment` no fim | loja sandbox identificável na resposta |
| C-56 | `get_products_overview` conta anúncio e venda Shopee (atende C-07) | A1 | `/produtos` | em código (D-445; `docs/MULTICHANNEL_CONTRACTS.md` §3.9) | SKU só da Shopee deixa de aparecer como "sem anúncio/sem venda"; contagens do ML iguais — provado lado a lado no Dev |
| C-58 | `get_shopee_faturamento`: TOTAL e por loja, resultado = recebido − custo, definitivo e provisório separados, imposto do dia (colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.5); NÃO soma com o resultado do ML | A1 | `/faturamento` (T5, atende C-03) | em produção (D-437, #152, 14/10) | os três resultados prontos; nada somado com o ML |
| C-59 | `get_marketplace_sku_sales` (ranking por SKU com colunas por marketplace e o total) e `get_sku_sales_by_marketplace_account` (aba Vendas do SKU); view `shopee_sales_items` (colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.6) | A1 | ranking e aba Vendas do SKU (T6, atende C-04 em parte) | em produção (D-439, #155, 14/10) | ML igual a `get_sku_sales_breakdown`; a soma dos SKUs da loja fecha com `get_shopee_sales_by_shop` |
| C-60 | Curva ABC por marketplace: `get_sku_abc_analysis`, `get_sku_abc_breakdown` e `get_sku_sales_by_account` com `p_marketplaces`/`p_account_ids` no fim, critério `compras`, colunas por marketplace (`docs/MULTICHANNEL_CONTRACTS.md` §3.7) | A1 | `/curva-abc` e o Excel (T6, atende C-04 em parte) | em código (D-441) | nulo = o ML de antes; com a Shopee, `orders`/cobertura nulos e `pedidos` recusado |
| C-61 | Componentes do faturamento Shopee sobre os pedidos cobertos (comissão, taxas, frete, cupons da loja, afiliados, ajustes e "outros" que fecham com o recebido), descontos bancados pela Shopee, série diária e, se o rateio fechar, por SKU | A1 | `/faturamento` (T5b: cascata, série e produtos) | em código (D-443; `docs/MULTICHANNEL_CONTRACTS.md` §3.8) | receita coberta − Σ componentes − outros = recebido coberto, provado em toda linha |
| C-62 | Devoluções da Shopee: `get_shopee_returns` (lista com itens e SKU) e `get_shopee_returns_summary` (TOTAL e por loja, por situação); colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.10 | A1 | vendas Shopee / atendimento (a tela é do A2) | em código (D-447) | situação como a Shopee manda (sem "reembolsado"); nada do comprador; sandbox fora do TOTAL; nunca lida = NULO |
| C-64 | Repasse da Shopee: `get_shopee_repasse_overview` (pelo dia da liberação, com o previsto e a diferença), `get_shopee_repasse_daily`, `get_shopee_repasses` e `get_shopee_repasse_pendente`; colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.12 | A1 | `/faturamento` (conciliação) — a tela é do A2 | em código (D-451) | NÃO somar ao recebido nem ao resultado; o liberado é do dia da liberação, não da venda; unidade do valor a conferir no sandbox |
| C-63 | Ads da Shopee: `get_shopee_ads_overview` (TOTAL e por loja, com a cobertura) e `get_shopee_ads_daily`; colunas em `docs/MULTICHANNEL_CONTRACTS.md` §3.11 | A1 | `/faturamento` e a central (a tela é do A2) | em código (D-449) | rotular "Ads CPC da loja"; NÃO descontar do resultado até conferir o GMV Max com loja real |
| C-57 | `search_entities` acha loja, anúncio e pedido Shopee (atende C-08) | A1 | busca universal | aceito; depois da E2 (a busca não pode furar a permissão por loja) | resultado Shopee só para quem alcança a loja |

---

## Arquivos que exigem coordenação

| Arquivo | Regra |
|---|---|
| `supabase/migrations/**`, `packages/db/src/types.ts` | só A1; carimbo conferido na pasta principal antes de criar (memória de sessões paralelas) |
| `apps/web/**` (telas e `apps/web/lib`) | A2; o A3 só em `components/carregando*`, `item-de-menu`, `formulario-filtro`, `filter-*`, `kpi-strip`, `saved-filters`, no bloco CARREGAMENTO de `globals.css` e em `lib/destino-do-formulario.ts` |
| `docs/METRICS.md` | A1 escreve a definição; A2 avisa se a tela precisar de uma métrica que não está lá |
| `docs/HANDOFF.md` | os dois, só a linha da própria frente, perto do limite de 25 KB do `docs:check` |
| `docs/MULTICHANNEL_HANDOFF.md` | este arquivo — cada um na sua seção |
| `AGENTS.md` | uma linha só no roteador ("Shopee, multicanal"), com os três documentos multicanais; quem mudar edita a mesma linha |
| `apps/web/lib/sync-health.ts` (`JOB_CADENCE_MIN`) | A2; `shopee.returns.sync` (60 min), `shopee.escrow-releases.sync` (60 min) e `shopee.ads.sync` (180 min) no #170 |

---

## Decisões pendentes do dono

1. ~~**E5 (exibição)**~~ — decidido pelo dono (14/10, relatado pelo A2): "pode usar todos os dados"; a T5 mostra o resultado total com a divisão definitivo/provisório.
2. **E6b a E7c — tudo na `main` (391c7165):** `migrations-producao.yml` para `20261015000000` a `20261015050000`; **E7a, E7b e E7c também publicam o worker, DEPOIS da migration** (os jobs leem as colunas novas); a E7d (push) publica a **api** e pede o cadastro do endereço no Console (`docs/DEPLOYMENT.md` §6.2) — esperar a CI da `main` terminar (a trava recusa antes) e fazer as duas aprovações. (E4, E5 e E6a: em produção desde 14/10.)
