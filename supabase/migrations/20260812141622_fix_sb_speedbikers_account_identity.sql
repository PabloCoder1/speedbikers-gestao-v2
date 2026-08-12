/*
 * Troca segura das identidades lógicas
 * SB <-> SpeedBikers.
 *
 * O código temporário existe somente
 * durante esta transação.
 */


/*
 * A constraint atual só permite:
 *
 * speedbikers
 * offracer
 * sb
 * gmr
 *
 * Permitimos temporariamente um código
 * auxiliar para realizar o swap sem
 * violar a unicidade de ml_accounts.code.
 */
alter table public.ml_accounts
drop constraint if exists ml_accounts_code_check;


alter table public.ml_accounts
add constraint ml_accounts_code_check
check (
  code in (
    'speedbikers',
    'offracer',
    'sb',
    'gmr',
    '__speedbikers_swap__'
  )
);


do $$
declare
  v_current_sb_id uuid;
  v_empty_speedbikers_id uuid;
  v_current_seller text;
begin

  /*
   * Registro que hoje possui code=sb,
   * mas contém a conta SpeedBikers real.
   */
  select
    id,
    seller_id::text
  into
    v_current_sb_id,
    v_current_seller

  from public.ml_accounts

  where code = 'sb'

  for update;


  /*
   * Registro atualmente reservado para
   * SpeedBikers, mas ainda vazio.
   */
  select
    id
  into
    v_empty_speedbikers_id

  from public.ml_accounts

  where code = 'speedbikers'

  for update;


  /*
   * Proteções.
   */
  if v_current_sb_id is null then
    raise exception
      'Conta lógica sb não encontrada.';
  end if;


  if v_empty_speedbikers_id is null then
    raise exception
      'Conta lógica speedbikers não encontrada.';
  end if;


  if v_current_sb_id =
     v_empty_speedbikers_id then
    raise exception
      'As contas sb e speedbikers apontam para o mesmo registro.';
  end if;


  if v_current_seller is distinct from
     '118570204' then

    raise exception
      'Seller inesperado na conta sb. Esperado 118570204, encontrado %.',
      v_current_seller;

  end if;


  /*
   * A linha que hoje se chama SpeedBikers
   * precisa realmente estar vazia.
   */
  if exists (
    select 1

    from public.ml_accounts

    where id =
      v_empty_speedbikers_id

    and seller_id is not null
  ) then

    raise exception
      'A linha speedbikers não está vazia. Migration cancelada.';

  end if;


  /*
   * 1.
   * Libera o código "sb".
   */
  update public.ml_accounts

  set
    code =
      '__speedbikers_swap__'

  where id =
    v_current_sb_id;


  /*
   * 2.
   * A linha vazia passa a representar
   * a verdadeira conta SB.
   *
   * IMPORTANTE:
   * oauth_app_code = speedbikers
   *
   * porque aquela aplicação OAuth será
   * utilizada quando formos conectar
   * a SB verdadeira.
   */
  update public.ml_accounts

  set
    code =
      'sb',

    display_name =
      'SB',

    oauth_app_code =
      'speedbikers',

    expected_seller_id =
      null,

    seller_id =
      null,

    nickname =
      null,

    connection_status =
      'not_connected',

    connected_at =
      null,

    last_synced_at =
      null

  where id =
    v_empty_speedbikers_id;


  /*
   * 3.
   * O registro que já possui pedidos,
   * anúncios, sync_runs e credenciais
   * ganha a identidade correta.
   *
   * O ID NÃO MUDA.
   *
   * IMPORTANTE:
   * oauth_app_code continua = sb
   * porque o token existente foi emitido
   * pela aplicação OAuth sb.
   */
  update public.ml_accounts

  set
    code =
      'speedbikers',

    display_name =
      'SpeedBikers',

    oauth_app_code =
      'sb',

    expected_seller_id =
      118570204,

    seller_id =
      118570204,

    nickname =
      'SPEEDBIKERSLOJA'

  where id =
    v_current_sb_id;

end
$$;


/*
 * O swap terminou.
 *
 * Voltamos a impedir qualquer código
 * temporário ou desconhecido.
 */
alter table public.ml_accounts
drop constraint if exists ml_accounts_code_check;


alter table public.ml_accounts
add constraint ml_accounts_code_check
check (
  code in (
    'speedbikers',
    'offracer',
    'sb',
    'gmr'
  )
);