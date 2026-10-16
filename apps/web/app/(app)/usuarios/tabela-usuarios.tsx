import Link from "next/link";
import type { ReactNode } from "react";

import { Avatar } from "../../../components/avatar";
import { CarregandoSeODemorar } from "../../../components/carregando-link";
import { Icone } from "../../../components/icons";
import { TOM } from "../../../components/tone";
import { MEMBER_STATUSES, buildMemberHref, memberStatusLabel, type MemberFilters, type MemberStatus } from "../../../lib/member-filters";
import { tomDePapel } from "../../../lib/role-tone";
import { DetalheUsuario, type EventoDeAcesso } from "./detalhe-usuario";
import { LinhaClicavel } from "./linha-clicavel";
import type { AccountOption } from "./member-controls";

/**
 * A TABELA E O FILTRO de `/usuarios`, separados da página (D-355).
 *
 * A página continua sendo quem LÊ o banco e decide cada valor; aqui só se
 * desenha. A separação existe por dois motivos: a composição ficou maior (avatar,
 * etiquetas de conta, estado com ponto, tempo relativo), e o desenho precisa ser
 * conferido sem login — uma prévia com dados de exemplo usa estes mesmos
 * componentes, e não uma cópia deles.
 *
 * ## O que mudou na leitura, e o que não mudou
 *
 * As cinco colunas são as de D-297, sem controle nenhum. Mudou a FORMA:
 *
 * - **a linha inteira abre a gaveta**, como no frame — o gatilho continua sendo
 *   o botão do nome (teclado e leitor de tela), e a linha repassa a ele o clique
 *   que cai em área neutra (`linha-clicavel.tsx`);
 * - **contas viram etiquetas**, até duas e "+N" — "Speed Bikers · Off Racer · SB
 *   · GMR" numa célula só se lia como frase;
 * - **o estado ganha um ponto** de cor, e a palavra continua lá (cor não é o
 *   único sinal);
 * - **o último acesso é relativo** ("há 3 dias"), com a data exata no `title`.
 */

export interface LinhaDeUsuario {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: string;
  readonly roleLabel: string;
  readonly nome: string | null;
  readonly foto: string | null;
  readonly email: string | null;
  readonly status: MemberStatus;
  readonly contas: readonly string[];
  readonly granted: string[];
  /** Rótulos das lojas Shopee concedidas (D-434), já resolvidos pela página. */
  readonly lojas: readonly string[];
  readonly lojasConcedidas: string[];
  readonly todasPorAdmin: boolean;
  readonly desde: string;
  readonly ultimoAcesso: string;
  readonly ultimoAcessoRelativo: string | null;
  readonly ehUltimoAdmin: boolean;
  readonly ehVoceMesmo: boolean;
  readonly historico: EventoDeAcesso[];
}

/** Quantas etiquetas de conta cabem antes do "+N". */
const CONTAS_VISIVEIS = 2;

/**
 * As etiquetas de alcance — contas do Mercado Livre ou, desde D-434, lojas
 * Shopee: a mesma regra (ADMIN alcança tudo pelo papel), a mesma forma.
 */
function Alcance({
  itens,
  todasPorAdmin,
  todas,
  nenhum,
}: {
  itens: readonly string[];
  todasPorAdmin: boolean;
  todas: string;
  nenhum: string;
}): ReactNode {
  if (todasPorAdmin) {
    return <span className="sb-chip sb-chip-info">{todas}</span>;
  }

  if (itens.length === 0) {
    return <span className="sb-texto-suave">{nenhum}</span>;
  }

  const visiveis = itens.slice(0, CONTAS_VISIVEIS);
  const resto = itens.length - visiveis.length;

  return (
    <span className="sb-chips" title={itens.join(" · ")}>
      {visiveis.map((item) => (
        <span key={item} className="sb-chip">
          {item}
        </span>
      ))}
      {resto > 0 && <span className="sb-chip sb-chip-mais">+{resto}</span>}
    </span>
  );
}

export function TabelaDeUsuarios({
  linhas,
  isAdmin,
  situacaoLida,
  historicoLido,
  accounts,
  lojas,
}: {
  linhas: readonly LinhaDeUsuario[];
  isAdmin: boolean;
  /**
   * T-R6: e-mail, situação e último acesso vêm de outra leitura (a janela de
   * `auth.users`). Se ela falhou, as duas colunas saem — "ativo" e "—" seriam
   * dado inventado, e a página diz por quê.
   */
  situacaoLida: boolean;
  /** O mesmo para o histórico: sem a leitura, a gaveta não diz "nenhuma mudança". */
  historicoLido: boolean;
  accounts: AccountOption[];
  /** As lojas Shopee que quem olha alcança (D-434). Sem nenhuma, a coluna não existe. */
  lojas: AccountOption[];
}): ReactNode {
  const temLojas = lojas.length > 0;

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="sb-table sb-tabela-usuarios">
        <thead>
          <tr>
            <th>Usuário / E-mail</th>
            <th>Papel</th>
            <th>Contas ML permitidas</th>
            {temLojas && <th>Lojas Shopee permitidas</th>}
            {/* Só para ADMIN: coluna vazia prometeria um dado que o usuário não vê. */}
            {situacaoLida && <th>Status</th>}
            {situacaoLida && <th className="sb-num">Último acesso</th>}
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <LinhaClicavel
              key={linha.userId}
              className={linha.status === "suspenso" ? "sb-linha-usuario sb-linha-suspensa" : "sb-linha-usuario"}
            >
              <td>
                <div className="sb-usuario-celula">
                  {/* `aria-hidden`: o nome acessível da célula segue nome + e-mail (D-234). */}
                  <Avatar nome={linha.nome ?? linha.email ?? "?"} fotoPath={linha.foto} />
                  <div className="sb-usuario-celula-texto">
                    <DetalheUsuario
                      accounts={accounts}
                      contas={linha.contas}
                      desde={linha.desde}
                      editavel={isAdmin}
                      ehUltimoAdmin={linha.ehUltimoAdmin}
                      ehVoceMesmo={linha.ehVoceMesmo}
                      email={linha.email}
                      fotoPath={linha.foto}
                      granted={linha.granted}
                      lojas={lojas}
                      lojasNomes={linha.lojas}
                      lojasConcedidas={linha.lojasConcedidas}
                      historico={linha.historico}
                      historicoVisivel={isAdmin && historicoLido}
                      nome={linha.nome}
                      organizationId={linha.organizationId}
                      role={linha.role}
                      roleLabel={linha.roleLabel}
                      status={linha.status}
                      todasPorAdmin={linha.todasPorAdmin}
                      ultimoAcesso={linha.ultimoAcesso}
                      userId={linha.userId}
                    />
                    {linha.email !== null && <div className="sb-usuario-celula-email">{linha.email}</div>}
                  </div>
                </div>
              </td>
              <td>
                {/* SELO, não `<select>` (D-297): o menu de papel mora na gaveta. */}
                <span className="sb-status" style={TOM[tomDePapel(linha.role)]}>
                  {linha.roleLabel}
                </span>
              </td>
              <td>
                <Alcance
                  itens={linha.contas}
                  todasPorAdmin={linha.todasPorAdmin}
                  todas="Todas as contas"
                  nenhum="Nenhuma conta associada"
                />
              </td>
              {temLojas && (
                <td>
                  <Alcance
                    itens={linha.lojas}
                    todasPorAdmin={linha.todasPorAdmin}
                    todas="Todas as lojas"
                    nenhum="Nenhuma loja associada"
                  />
                </td>
              )}
              {situacaoLida && (
                <td>
                  <span className="sb-estado-pessoa" data-status={linha.status}>
                    <i aria-hidden="true" />
                    {memberStatusLabel(linha.status)}
                  </span>
                </td>
              )}
              {situacaoLida && (
                <td className="sb-num">
                  <span className="sb-acesso-celula">
                    {/* Nunca entrou é "—", não uma data inventada. */}
                    <span title={linha.ultimoAcessoRelativo === null ? undefined : linha.ultimoAcesso}>
                      {linha.ultimoAcessoRelativo ?? "—"}
                    </span>
                    <Icone nome="avancar" tamanho={14} />
                  </span>
                </td>
              )}
            </LinhaClicavel>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * O plural que a pílula usa; a coluna usa o singular de `memberStatusLabel`.
 *
 * "Pendentes", e não "Convites pendentes": o cartão da faixa, logo acima, já
 * diz "Convites pendentes", e o mesmo rótulo duas vezes na tela foi o que o e2e
 * acusou (`getByText` ambíguo) — e o que o olho também lê como repetição. Ao lado
 * de "Ativos", "Pendentes" não precisa do substantivo.
 */
const PILULA: Record<MemberStatus, string> = {
  ativo: "Ativos",
  pendente: "Pendentes",
  suspenso: "Suspensos",
};

/**
 * O FILTRO DE STATUS em pílulas, com a contagem de cada uma (D-355).
 *
 * Era o menu "Status ⌄" do frame: três opções escondidas atrás de um clique, e
 * nenhuma dizia quantas pessoas havia em cada estado. Com três estados, as
 * opções cabem à vista, e a contagem responde "tem alguém suspenso?" sem
 * filtrar. Continuam sendo LINKS com o recorte na URL (D-297), e a busca
 * é preservada ao trocar de pílula.
 *
 * As contagens são da organização inteira, não do recorte da busca: a pílula
 * diz quantas pessoas há naquele estado, e a frase da janela diz o recorte.
 */
export function FiltroDeStatus({
  filters,
  contagens,
  total,
}: {
  filters: MemberFilters;
  contagens: Readonly<Record<MemberStatus, number>>;
  total: number;
}): ReactNode {
  const opcoes: { estado: MemberStatus | null; rotulo: string; conta: number }[] = [
    { estado: null, rotulo: "Todos", conta: total },
    ...MEMBER_STATUSES.map((estado) => ({ estado, rotulo: PILULA[estado], conta: contagens[estado] })),
  ];

  return (
    <nav className="sb-pilulas" aria-label="Filtrar por status">
      {opcoes.map((opcao) => (
        <Link
          key={opcao.estado ?? "todos"}
          href={buildMemberHref(filters, { status: opcao.estado })}
          className="sb-pilula"
          data-status={opcao.estado ?? undefined}
          aria-current={filters.status === opcao.estado ? "page" : undefined}
        >
          {opcao.rotulo}
          <span className="sb-pilula-conta">{opcao.conta}</span>
          <CarregandoSeODemorar />
        </Link>
      ))}
    </nav>
  );
}
