// A mesma tela de carregamento de `app/loading.tsx`: navegar de `/vendas` para
// `/vendas/shopee` troca um segmento DENTRO da seção, e sem este arquivo a tela
// antiga congelaria até a nova chegar. A guarda `check:loading` reprova página
// nova sem ele.
export { default } from "../../loading";
