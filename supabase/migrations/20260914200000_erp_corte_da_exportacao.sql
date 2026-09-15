-- D-351 -- o corte do snapshot do UpSeller passa a ser o instante da EXPORTACAO
-- da planilha, nao o do parse.
--
-- O DEFEITO. `erp_stock_snapshots.captured_at` recebia `erp_import_batches.parsed_at`
-- (`erp-import-apply.ts`). O saldo da `Lista_de_Estoque` e o Disponivel do ERP no
-- instante em que ela foi exportada, e o UpSeller puxa o pedido do Mercado Livre na
-- hora (resposta do dono, 2026-09-14). Toda venda entre a exportacao e o parse ficava
-- tratada como "ja descontada na planilha" sem estar. Medido:
--
--   producao  Lista_de_Estoque_0914184200.xlsx  exportado 18:42:00  parse 18:44:13.254
--             (1 pedido vinculado fechou nessa janela: 2000018457209778)
--   Dev       Lista_de_Estoque_0820160923.xlsx  exportado 08-20 16:09:23  parse 08-21 15:42:02
--
-- O nome e UTC: o lote de producao foi enviado as 18:44:11 UTC, e em BRT a exportacao
-- seria 21:42 UTC, depois do envio. No Dev ele casa com o segundo carimbo dos outros tres
-- arquivos da mesma exportacao (`..._202608201308-20260820160836...`, BRT e UTC).
--
-- POR QUE CORRIGIR `captured_at` E NAO CRIAR `exported_at`. O corte tem tres leitores
-- que PRECISAM concordar: o gate do worker (`get_erp_stock_cutoffs`, migration
-- seguinte), `compute_erp_target_balances` e a compensacao dos movimentos ja gravados.
-- Uma coluna nova exigiria mudar os tres e deixaria `captured_at` com o valor errado e o
-- nome certo, esperando o proximo leitor. Corrigir o valor mantem os tres na mesma
-- coluna por construcao -- `compute_erp_target_balances` fica INTACTA -- e a coluna
-- passa a dizer o que o nome sempre prometeu: quando o retrato foi tirado.
--
-- A REGRA (gemea de `resolveStockExportInstant`, `packages/domain/src/upseller/`):
--   - `Lista_de_Estoque_MMDDHHMMSS` no nome, em UTC; o ano e o vizinho (anterior, o do
--     parse ou o seguinte) mais proximo do parse;
--   - limitado a [parsed_at - 24 h, parsed_at];
--   - sem o padrao, ou com data impossivel: parsed_at, o comportamento de antes.
-- A integracao compara as duas implementacoes caso a caso. Se uma mudar sem a outra, o
-- corte do worker e o do banco divergem.

create function private.erp_stock_export_instant(p_file_name text, p_parsed_at timestamptz)
returns timestamptz
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_digitos text;
  v_mes int;
  v_dia int;
  v_hora int;
  v_minuto int;
  v_segundo int;
  v_ano_parse int;
  v_ano int;
  v_candidato timestamptz;
  v_melhor timestamptz;
begin
  if p_parsed_at is null then
    return null;
  end if;

  v_digitos := substring(coalesce(p_file_name, '') from 'Lista_de_Estoque_([0-9]{10})(?![0-9])');

  if v_digitos is null then
    return p_parsed_at;
  end if;

  v_mes := substr(v_digitos, 1, 2)::int;
  v_dia := substr(v_digitos, 3, 2)::int;
  v_hora := substr(v_digitos, 5, 2)::int;
  v_minuto := substr(v_digitos, 7, 2)::int;
  v_segundo := substr(v_digitos, 9, 2)::int;

  if v_mes < 1 or v_mes > 12 or v_dia < 1 or v_hora > 23 or v_minuto > 59 or v_segundo > 59 then
    return p_parsed_at;
  end if;

  v_ano_parse := extract(year from p_parsed_at at time zone 'UTC')::int;

  for v_ano in v_ano_parse - 1 .. v_ano_parse + 1 loop
    -- Dia 1 sempre existe; somar os dias e conferir o mes e o que distingue
    -- data real (29/02 em ano bissexto) de data impossivel (30/02), sem excecao.
    v_candidato := make_timestamptz(v_ano, v_mes, 1, v_hora, v_minuto, v_segundo, 'UTC')
      + make_interval(days => v_dia - 1);

    continue when extract(month from v_candidato at time zone 'UTC')::int <> v_mes;

    if v_melhor is null
       or abs(extract(epoch from v_candidato - p_parsed_at)) < abs(extract(epoch from v_melhor - p_parsed_at)) then
      v_melhor := v_candidato;
    end if;
  end loop;

  if v_melhor is null then
    return p_parsed_at;
  end if;

  return greatest(least(v_melhor, p_parsed_at), p_parsed_at - interval '24 hours');
end;
$$;

comment on function private.erp_stock_export_instant(text, timestamptz) is
  'Instante da exportacao da planilha de estoque do UpSeller, lido do nome Lista_de_Estoque_MMDDHHMMSS (UTC), limitado a [parse - 24 h, parse]; sem o padrao, o parse (D-351). Gemea de resolveStockExportInstant em @sb/domain -- a integracao compara as duas.';

revoke all on function private.erp_stock_export_instant(text, timestamptz) from public, anon, authenticated;

-- Os snapshots ja gravados. So as linhas que ainda carregam o parse como corte
-- (`captured_at = parsed_at`), o que torna a correcao idempotente: depois dela o valor
-- difere do parse, e o worker novo ja grava a exportacao.
--
-- Efeito medido antes de aplicar: producao, 3.098 linhas de 18:44:13.254 para 18:42:00;
-- Dev, 3.372 linhas de 08-21 15:42:02.459 para 08-20 16:09:23 (23 h 33 min antes -- no Dev
-- a reconciliacao ja rodou com o corte velho, e a proxima rodada, quando o Dev voltar,
-- passa a contar as vendas dessa janela no alvo; e o certo pela resposta do dono).
update public.erp_stock_snapshots s
   set captured_at = private.erp_stock_export_instant(b.file_name, b.parsed_at)
  from public.erp_import_batches b
 where b.id = s.batch_id
   and b.kind = 'STOCK'
   and b.parsed_at is not null
   and s.captured_at = b.parsed_at
   and private.erp_stock_export_instant(b.file_name, b.parsed_at) <> s.captured_at;

comment on column public.erp_stock_snapshots.captured_at is
  'Instante da EXPORTACAO da planilha do UpSeller -- o corte do snapshot: venda com "venda em" ate aqui ja esta no saldo do ERP (D-351). Ate D-351 era o instante do parse.';
