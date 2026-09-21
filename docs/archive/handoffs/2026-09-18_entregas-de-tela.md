# Entregas de tela concluidas em 2026-09-18

Sairam do `HANDOFF.md` por serem historia (entrega fechada), pela regra de D-177.

`/estoque/[skuId]/ajuste` virou um fluxo operacional completo: entrada, saída e
balanço sem sinal manual, prévia do saldo, motivo estruturado, autoria, histórico
recente, bloqueio seguro quando saldo/permissão falha e layout responsivo. O
núcleo está em `01d1ce7`, com validação local completa (`check`, `build`,
`docs:check` e E2E responsivo) nesta entrega.

`/estoque/movimentacoes` recebeu a reconstrução da experiência operacional: cabeçalho e faixa de indicadores do Design System, filtros agrupados com busca por referência, estados de erro e vazio explícitos, paginação preservada e tabela responsiva com dimensões separadas de movimento, local, origem, referência, motivo e responsável. A tela segue somente leitura e as consultas continuam em RPCs paginadas sob RLS; a migration `20260918125153` alinha busca por referência e datas inclusivas entre extrato e indicadores. Verificação local: `pnpm run check`, `pnpm run build`, `pnpm docs:check` e inspeção visual autenticada em desktop.

`/full` virou fila de envio (D-380): cobertura por linha (Full ÷ venda média diária
da janela), focos "Acabando" e "Pode enviar hoje", ordem por prioridade de envio e CSV
do recorte. Depende da migration `20260918140000`; sem ela a tela degrada para a
assinatura antiga com aviso.
