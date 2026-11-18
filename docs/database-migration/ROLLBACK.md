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

## Retorno do corte de 18/11/2026 (VM para o Supabase hospedado)

**Só faz sentido com o Supabase hospedado retomado** (plano pago, ou o banco abaixo de 500 MB): ele está
pausado, e a VM é a fonte da verdade desde o corte. **Tudo o que foi gravado na VM depois do corte não
volta** para o hospedado sem uma carga nova.

1. Pausar o Scheduler e escalar o worker a zero.
2. Segredo `SUPABASE_SERVICE_ROLE_KEY`: desabilitar a versão 2 (a `latest` volta a ser a 1).
3. Cloud Run: `api` para `api-00038-qsf` e `worker` para `worker-00056-wjk`, 100% cada.
4. Vercel: variáveis para `https://imvjfgnaprqsfjlnsyev.supabase.co` e a chave publicável do projeto
   hospedado (os valores antigos ficaram criptografados e não são legíveis), e novo deploy do commit
   `d6169205`; ou promover o deploy anterior `dpl_64mHs5sni1awBJEqjqcjF7UNmWtt`, que já traz as
   variáveis antigas embutidas.
5. Reativar o Scheduler. A VM permanece de pé, com os backups, até a decisão final.
