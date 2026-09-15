import Link from "next/link";
import type { ReactNode } from "react";

/**
 * O bloco da MARCA no topo da sidebar — a logo da Speed Bikers.
 *
 * Até aqui era um quadrado amarelo com as iniciais da organização e o nome em
 * texto, porque "este app não tem nenhuma imagem" e inventar um arquivo de logo
 * não era trabalho da frente visual. A logo chegou do dono da marca
 * (`public/brand/`, recortada e reduzida do original de 1254px); o frame do
 * Figma sempre desenhou uma IMAGEM aqui, e é o que volta.
 *
 * - **Expandida:** a logo horizontal (emblema + "SPEED BIKERS"), com o contorno
 *   claro das letras que a mantém legível sobre o navy.
 * - **Trilho (≤ 850px):** só o emblema — a logo horizontal não cabe em 58px e
 *   viraria um borrão.
 *
 * `<img>` e não `next/image`: são dois arquivos estáticos de poucos KB já no
 * tamanho de exibição (1x e 2x por `srcSet`), e o otimizador de imagens seria
 * uma função no caminho de um recurso que não precisa de nada. Dimensões
 * declaradas, então a caixa não pula enquanto a imagem chega.
 *
 * Um componente só para o Shell e para a tela de carregamento: eram duas cópias
 * do mesmo bloco, e a de carregamento teria ficado com a marca antiga.
 */
export function Marca(): ReactNode {
  return (
    <Link href="/" className="sb-brand" aria-label="Speed Bikers Gestão — início">
      <img
        className="sb-brand-logo"
        src="/brand/logo-48.webp"
        srcSet="/brand/logo-48.webp 1x, /brand/logo-96.webp 2x"
        width={144}
        height={32}
        alt=""
        decoding="async"
      />
      <img
        className="sb-brand-emblema"
        src="/brand/emblema-40.webp"
        srcSet="/brand/emblema-40.webp 1x, /brand/emblema-80.webp 2x"
        width={39}
        height={24}
        alt=""
        decoding="async"
      />
      <small className="sb-brand-produto">GESTÃO</small>
    </Link>
  );
}
