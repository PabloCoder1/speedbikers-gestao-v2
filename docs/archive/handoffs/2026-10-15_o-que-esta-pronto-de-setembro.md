# "O que está pronto", tirado do HANDOFF em 2026-10-15

> Movido de `docs/HANDOFF.md` para abrir espaço no budget de 25 KB do `docs:check`
> (D-177): o arquivo chegou a 25,5 KB e a próxima linha de qualquer agente reprovava.
> Eram entregas de setembro, já no ar; ficam aqui como história, sem edição.

`/notificacoes` (D-393): triagem por severidade/família/conta; 556 ms → 63 ms; migration
`20260923200000`. O PR #53 mexe nos mesmos arquivos.

`/central` (D-394/D-395): indicadores contra o período anterior, meta do mês com projeção e imposto com vigência (cadastro em `/central/metas`). D-396 frete 100% desde 25/06; D-397/399 frete; D-398/401 Ads; D-400 atenção na central; D-402 ranking de produtos; D-403/D-404 alertas em `actions`, uma fonte por chamada; D-405 medidas do pacote por envio; D-406 datas comerciais na projeção (migration `20260923195955`); D-407 quem paga o frete (worker-00027); D-408 limites em `/central/limites`; D-409 detector lendo `shipping_sales`; D-410 margem mínima e piso do ROAS da organização no SQL. D-411: o alerta alto novo vira notificação (migration `20260925140000`). D-412: quem paga o frete, por envio (migration `20260925150000`). D-413: o frete do envio compartilhado conta uma vez (migration `20260925160000`).

`/atendimento/conhecimento`: filtros, paginação e modal — já na `main` (`4c34bc68`).

Fases 0–4, 5A–5D, 6, 6B, 7, 7B e 9 (backend) concluídas nos critérios
registrados. A trilha 5E entregou as seis centrais analíticas
(Movimentações, Dashboard 360º do Anúncio, abas do SKU, Preços, Full,
Fornecedor). A 8A entregou Usuários/Permissões (D-175) e Saúde do
Sistema (D-176). **Integrações e Configurações também existem** — a checagem de
D-271 desmentiu a nota anterior, que dizia faltarem.

A `/estoque` segue o frame `Inventory` com a faixa única de indicadores,
filtros dentro do painel, busca operacional, identidade de produto e ações
compactas por linha. As recusas métricas de D-249 permanecem intactas; a
mudança é de hierarquia e velocidade percebida, sem inventar agregado.

`/anuncios`: D-381 (ordem, faixa numa passada, foto). **Worker só depois de `20260918150000`.**

Entregas de tela fechadas em 18/09 (ajuste de estoque, `/full` D-380, `/estoque/movimentacoes`): `docs/archive/handoffs/2026-09-18_entregas-de-tela.md`.

`/sincronizacao` resume por conta conexão, confiança, frescor, falhas e a
cobertura do histórico de pedidos (365 dias, 100% só no fim do backfill;
`docs/METRICS.md`). Migration `20260921114355` em Dev e produção.

Página nova precisa de `loading.tsx` (D-382, guarda `check:loading`).
`/anuncios`: resumo do recorte, visões rápidas, CSV e cartões no celular (D-385, migration `20260918200000`).
