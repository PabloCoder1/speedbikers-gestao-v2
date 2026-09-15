"use client";

import { useState, type ReactNode } from "react";

import { Avatar } from "./avatar";
import { CampoFoto } from "./campo-foto";
import { DetailRow, Drawer } from "./drawer";
import { EditarNome } from "./editar-nome";

/**
 * O BLOCO DE PERFIL do topo, que agora abre o "Meu perfil" (D-354).
 *
 * O pedido: a pessoa coloca a própria foto "quando quiser, enquanto estiver
 * com o seu login". O lugar em que todo mundo já se vê é o canto do topo — uma
 * tela "Minha conta" nova seria mais uma rota a achar. O bloco era informação
 * parada; virou o gatilho de uma gaveta, com a mesma aparência.
 *
 * Nome e foto se editam aqui sob a MESMA policy da gaveta de `/usuarios`
 * (`profiles_update_self_or_org_admin`): a própria pessoa sempre pode.
 */
export function MeuPerfil({
  userId,
  nomeExibido,
  nomeNoPerfil,
  email,
  papel,
  fotoPath,
}: {
  /** Sem sessão legível não há de quem editar: o bloco volta a ser só texto. */
  userId: string | null;
  /** O que o topo mostra: o nome do perfil, ou o e-mail quando não há nome. */
  nomeExibido: string;
  /** O nome de verdade — nulo quando a pessoa ainda não tem. */
  nomeNoPerfil: string | null;
  email: string;
  papel: string;
  fotoPath: string | null;
}): ReactNode {
  const [aberto, setAberto] = useState(false);

  const conteudo = (
    <>
      <Avatar nome={nomeExibido} fotoPath={fotoPath} />
      <span style={{ minWidth: 0 }} title={email}>
        <b>{nomeExibido}</b>
        <small>{papel}</small>
      </span>
    </>
  );

  if (userId === null) {
    return <div className="sb-profile">{conteudo}</div>;
  }

  return (
    <>
      <button
        type="button"
        className="sb-profile"
        aria-label={`Meu perfil — ${nomeExibido}`}
        onClick={() => {
          setAberto(true);
        }}
      >
        {conteudo}
      </button>

      {aberto && (
        <Drawer
          eyebrow="Meu perfil"
          label="Meu perfil"
          onClose={() => {
            setAberto(false);
          }}
        >
          <div className="sb-usuario-cabeca">
            <div style={{ minWidth: 0, flex: 1 }}>
              <span className="sb-object-id">Você</span>
              <h3 className="sb-usuario-nome">{nomeNoPerfil ?? "sem nome no perfil"}</h3>
              <span className="sb-usuario-email">{email}</span>
              <EditarNome userId={userId} nome={nomeNoPerfil} />
            </div>
          </div>

          <div className="sb-drawer-card">
            <h4>Foto de perfil</h4>
            <CampoFoto nome={nomeExibido} fotoAtual={fotoPath} modo={{ tipo: "imediato", userId }} />
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <DetailRow label="E-mail" value={email} note="é o login; só muda pelo administrador do sistema" />
            <DetailRow label="Papel" value={papel} note="quem muda o papel é um ADMIN, em Usuários" />
          </div>
        </Drawer>
      )}
    </>
  );
}
