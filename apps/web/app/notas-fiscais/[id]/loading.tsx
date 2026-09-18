// A mesma tela de carregamento de `app/loading.tsx`, repetida em cada pasta com
// páginas: o `loading.tsx` da raiz só aparece quando o PRIMEIRO segmento muda
// (`/vendas` → `/anuncios`), e navegar dentro da seção (`/anuncios` →
// `/anuncios/MLB…`) congelava a tela antiga até a nova chegar. A guarda
// `check:loading` reprova página nova sem este arquivo.
export { default } from "../../loading";
