-- O worker de sync usa o cliente privilegiado (service_role) e precisa
-- poder disparar a atualizacao. anon e authenticated seguem sem acesso:
-- isto e operacao de background, nao acao de usuario.
grant execute on function public.refresh_stock_sale_deductions() to service_role;
