# Plano de retorno

> Database Sentinel, 17/11/2026.

## Retomada na organização Pro (caminho recomendado)

Não há o que desfazer no banco: é a mesma instância. Para voltar ao custo
anterior, o dono transfere o projeto de volta ou rebaixa a organização. Um
banco de mais de 500 MB rebaixado para o Free fica em somente leitura:
**isso é uma parada, não um retorno**.

## Migrations de otimização

| Item | Volta |
|---|---|
| R5 (índice) | Migration nova recria `fulfillment_stock_snapshots_timeline_idx` e a constraint unique original. Sem perda |
| R3/R4 (retenção) | `cron.unschedule` do job. **O que já foi apagado não volta:** antes do 1º expurgo, dump das linhas que sairão (`pg_dump --table` com filtro por cópia temporária) guardado fora do Git |
| R1 (compactação do Full) | Igual a R3. A série continua reconstruível (só repetições saem) |
| R2 (notificação informativa) | Reverter a regra de fan-out. Entregas não feitas não são recriadas |

## Migração para o Neon (contingência)

- A origem Supabase fica **intacta e pausada (não excluída) por ≥ 30 dias**
  depois do corte.
- Retorno = reverter as variáveis da Vercel e do Cloud Run para a origem
  (revisões anteriores fixas, D-342) e retomar o projeto.
- Escritas feitas no Neon depois do corte têm de ser levadas de volta: por
  isso a janela de validação vem **antes** de liberar o worker, e o corte
  só sai com a VALIDATION §1 verde.
- Nunca usar "Production rebuild" da Vercel para voltar (memória do
  projeto: reconstrói commit velho).
