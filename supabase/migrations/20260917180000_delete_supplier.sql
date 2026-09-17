-- ============================================================
-- D-372 -- excluir fornecedor.
--
-- O pedido do dono: "falta o botao de apagar fornecedor". Ate aqui so havia
-- inativar (D-366), e um cadastro feito por engano -- nome errado, duplicado
-- -- ficava para sempre na lista de inativos.
--
-- A REGRA: so se exclui fornecedor SEM NENHUM pedido de compra, em estado
-- nenhum (cancelado incluido). `purchase_orders.supplier_id` e
-- `on delete restrict` desde a Fase 4, de proposito: o pedido guarda de quem
-- se comprou, e apagar o fornecedor apagaria essa resposta. Com pedido, o
-- caminho continua sendo inativar -- sai da escolha de novos pedidos, o
-- historico fica. A funcao diz isso com numero, em vez de deixar a FK
-- estourar com um erro que a tela nao saberia traduzir.
--
-- `suppliers` so muda por RPC; nao ha DELETE para `authenticated` na tabela.
--
-- O timestamp fica depois de 20260917170000 (D-371), reservado por outra
-- frente quando esta foi escrita: a ordem do `db push` precisa ser a do nome.
-- ============================================================

create function public.delete_supplier(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_logo text;
  v_pedidos bigint;
begin
  select s.organization_id, s.logo_path
    into v_org, v_logo
  from public.suppliers s
  where s.id = p_id
  for update;

  if v_org is null then
    raise exception 'fornecedor % nao encontrado', p_id;
  end if;

  -- Papel NA organizacao do fornecedor (D-180).
  if not private.has_org_role(v_org, array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para excluir o fornecedor';
  end if;

  select count(*) into v_pedidos
  from public.purchase_orders po
  where po.supplier_id = p_id;

  if v_pedidos > 0 then
    raise exception 'fornecedor tem % pedido(s) de compra', v_pedidos
      using hint = 'Inative o fornecedor: ele sai da escolha de novos pedidos e o historico fica.';
  end if;

  delete from public.suppliers where id = p_id;

  -- A logo, se havia, para a tela apagar o arquivo do bucket depois.
  return v_logo;
end;
$$;

comment on function public.delete_supplier(uuid) is
  'Exclui um fornecedor SEM nenhum pedido de compra e devolve o caminho da logo (NULL sem logo) para a tela apagar o arquivo (D-372). ADMIN/GESTOR da organizacao do fornecedor. Com pedido, recusa com a contagem: o caminho e inativar, porque purchase_orders.supplier_id e on delete restrict de proposito.';

revoke all on function public.delete_supplier(uuid) from public, anon;
grant execute on function public.delete_supplier(uuid) to authenticated, service_role;
