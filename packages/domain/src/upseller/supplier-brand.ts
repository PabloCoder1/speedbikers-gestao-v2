import { cell } from "./normalize.js";

/**
 * Marca REAL do fornecedor, resolvida a partir da linha do UpSeller (D-390).
 *
 * `skus.brand` guarda a coluna `Categorias`, que NÃO é marca (D-129): em
 * 2.037 das 3.074 linhas do export de 22/09/2026 ela é tipo de peça mais
 * modelo de moto (`MANETE→CB 300R`), e em 356 é status ou ruído de cadastro
 * (`999`, `ESTOQUE INATIVO`, `OCUPADO`). Copiar `Categorias` para a marca é o
 * que carimbou 2.393 SKUs como `OFFRACER` em produção — inclusive 20 que têm
 * `RT PARTS` escrito no próprio título.
 *
 * Por isso a marca não sai de uma coluna só. Sai de uma CASCATA, da evidência
 * mais forte para a mais fraca, e **para na primeira que decide**:
 *
 *   1. `Categorias` — quando é marca de verdade (sem seta, sem ser número nem
 *                     status). Decide **672** linhas.
 *   2. `Marca`      — a coluna homônima do ERP, para o que a categoria não
 *                     nomeia. **46**.
 *   3. `Descrição`  — "Marca: Off Racer;" escrito na cópia do anúncio. **44**.
 *   4. Título/SKU   — a marca escrita no título, ou o prefixo `off`/`kitoff`
 *                     do código, como já fazia a semeadura de D-129. **548**.
 *   5. Linha de produto — Jupiter, TM2, Sahara, XL, Pegasus, Naked e V2 são
 *                     linhas Off Racer. **1.168**.
 *   6. O balde `999` — Off Racer, por declaração do dono. **75**.
 *
 * Total: **2.553 de 3.074 (83,1%)**, contados rodando este módulo sobre o
 * arquivo real.
 *
 * **A ordem entre 1 e 2 foi medida, não escolhida.** O dono exportou o
 * catálogo em 20 arquivos, um por `Categorias`, e chamou cada um de marca:
 * 1.016 SKUs com marca declarada por ele. Com a coluna `Marca` na frente, a
 * cascata batia com essa declaração em 77,6%; com `Categorias` na frente,
 * **99,5%** (928 de 933, fora o grupo `ESTOQUE INATIVO`). O ERP tem `Marca`
 * preenchida em 181 linhas e ela contradiz a categoria em 66 — são peças
 * genéricas que o catálogo compra de mais de um fornecedor, e quem decide
 * qual deles nomeia o item é o dono, não o ERP.
 *
 * As 5 divergências que sobram são `Manete RT CG LONA`: estão no arquivo Off
 * Racer do dono e dizem `RT` no título e na coluna `Marca`. A cascata fica com
 * RT, e a correção, se for o caso, é uma edição na tela.
 *
 * **Sem evidência, devolve `null` de propósito.** As outras **521** linhas
 * ficam assim — manete nomeado só pelo modelo da moto ("Manete Curto (MT03)").
 * É decisão, não lacuna: marca inventada vira regra de compra errada. Quem
 * preenche essas é gente, na tela `/produtos`.
 *
 * Funções puras, sem I/O — a mesma cascata vale para qualquer parser futuro.
 */

/** Grafias do mesmo fornecedor. Medidas no export, não supostas. */
const SINONIMOS: ReadonlyMap<string, string> = new Map([
  ["OFFRACER", "OFF RACER"],
  ["OFF-RACER", "OFF RACER"],
  ["AOLIXIN", "AOLIXIM"],
  ["T-MAC", "TMAC"],
  ["RT PARTS", "RT"],
  ["RTPARTS", "RT"],
  ["PANDAO", "PANDÃO"],
  ["MASTER & CIA", "MASTER"],
  ["PROJECAO", "PROJEÇÃO"],
]);

/**
 * Marcas que o catálogo já conhece.
 *
 * Serve para DOIS jobs: reconhecer a marca escrita no meio de um texto livre
 * (título e descrição), e separar marca de lixo numa célula suja. Uma marca
 * nova NÃO precisa entrar aqui para ser aceita pelas etapas 1 e 2 — a lista
 * fecha só o que pode ser garimpado de texto corrido.
 */
const MARCAS_CONHECIDAS: readonly string[] = [
  "OFF RACER",
  "NAVETEC",
  "PLASMOTO",
  "RT",
  "TMAC",
  "AOLIXIM",
  "EMBUS",
  "PANDÃO",
  "R1 MOTOPARTS",
  "ATEC",
  "SAKAMAX",
  "SPORTIVE",
  "MASTER",
  "OFF VOLT",
  "VELOCE",
  "REINNER",
  "PROJEÇÃO",
  "RED DRAGON",
  "OCTOPLUS",
];

/**
 * Valores de `Categorias` que nunca são marca.
 *
 * `ESTOQUE INATIVO` já vira `isDiscontinued` em `parseCategory`; `OCUPADO` é
 * rascunho de cadastro. Estão aqui porque a marcação em lote de 14/09 os
 * gravou como marca em 254 SKUs de produção.
 */
const NAO_E_MARCA: ReadonlySet<string> = new Set(["ESTOQUE INATIVO", "OCUPADO"]);

/**
 * Linhas de produto Off Racer, como FRASE e não como palavra solta.
 *
 * A frase é deliberada: `XL` e `SAHARA` também são nome de moto (Honda XL,
 * NX 350 Sahara). Exigir `MANOPLA XL` e `MANETE SAHARA` cobre as 270 e 23
 * linhas medidas no export sem prometer que um manete de Honda XL 250 vai
 * virar Off Racer no dia em que ele entrar no catálogo.
 *
 * `TM2` fica sozinho por não existir moto com esse nome.
 *
 * Prova, dentro do próprio arquivo: nas linhas dessas famílias em que o ERP
 * preenche `Marca` ou escreve a marca no texto, o resultado é Off Racer em
 * 286 de 286 — Jupiter 220, TM2 44, Sahara 22. XL, Pegasus, Naked e V2 não
 * têm nenhuma evidência no arquivo e entram aqui pela declaração do dono em
 * 22/09/2026.
 */
const LINHAS_DE_PRODUTO: readonly (readonly [string, string])[] = [
  ["MANOPLA JUPITER", "OFF RACER"],
  ["MANOPLA XL", "OFF RACER"],
  ["MANOPLA PEGASUS", "OFF RACER"],
  ["MANOPLA V2", "OFF RACER"],
  ["MANETE SAHARA", "OFF RACER"],
  ["GUIDAO NAKED", "OFF RACER"],
  ["TM2", "OFF RACER"],
];

/**
 * O balde sem categoria, e a quem ele pertence.
 *
 * `999` é o "sem categoria" do UpSeller: 261 linhas no export de 22/09. O dono
 * exportou esse grupo inteiro como Off Racer em 22/09/2026, e o conteúdo
 * confirma — são acessórios da linha dele (Guidão 28mm, Guidão 22mm, Retrovisor
 * Tomok 2, Peso e Tampa de Guidão, Kit Guidão Esportivo).
 *
 * **É a ÚLTIMA etapa da cascata, de propósito.** Um item de outra marca que
 * caia no balde ainda é pego antes pela coluna `Marca`, pela descrição ou pelo
 * título — é o que acontece com as cinco linhas `Manete RT CG LONA`, que saem
 * como RT mesmo estando no arquivo Off Racer do dono. O risco que sobra está
 * dito: item sem categoria, sem marca declarada e sem o nome no título vira
 * Off Racer. Corrigir um desses é uma edição na tela `/produtos`, que grava
 * `MANUAL` e passa a ser intocável pelo importador.
 */
const BALDE_SEM_CATEGORIA: ReadonlyMap<string, string> = new Map([["999", "OFF RACER"]]);

/** Prefixos de código que carregam a marca (D-129). */
const PREFIXOS_DE_SKU: readonly (readonly [string, string])[] = [
  ["KITOFF", "OFF RACER"],
  ["OFF", "OFF RACER"],
  ["RT-", "RT"],
];

/** Espelha o CHECK `skus_supplier_brand_shape`. */
const MARCA_MAX = 60;

export type SupplierBrandOrigin = "MARCA" | "CATEGORIA" | "DESCRICAO" | "TITULO" | "LINHA" | "BALDE";

export interface SupplierBrandInput {
  readonly sku: string;
  readonly title: unknown;
  readonly brandColumn: unknown;
  readonly categories: unknown;
  readonly description: unknown;
}

export interface SupplierBrandResult {
  readonly brand: string | null;
  readonly origin: SupplierBrandOrigin | null;
}

const SEM_MARCA: SupplierBrandResult = { brand: null, origin: null };

/** Caixa alta, sem acento, sem pontuação, com borda — para busca por frase. */
function buscavel(value: string): string {
  const semAcento = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

  return ` ${semAcento.replace(/[^A-Z0-9]+/g, " ").trim()} `;
}

/** Colapsa espaço e caixa, preservando acento (a marca gravada mantém `PANDÃO`). */
function limpar(value: string): string {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

function canonico(value: string): string {
  return SINONIMOS.get(value) ?? value;
}

/**
 * Marcas conhecidas citadas dentro de um texto livre.
 *
 * Varre também as GRAFIAS alternativas: sem isso, `TMAC - 157,11 aolixin` era
 * lido como uma marca só (o `AOLIXIN` com N não bate com o `AOLIXIM` canônico)
 * e a célula suja decidia por TMAC em vez de não decidir.
 */
function marcasNoTexto(texto: string): string[] {
  const alvo = buscavel(texto);
  const achadas = new Set<string>();
  const grafias: [string, string][] = [
    ...MARCAS_CONHECIDAS.map((marca): [string, string] => [marca, marca]),
    ...[...SINONIMOS.entries()],
  ];

  for (const [grafia, marca] of grafias) {
    if (alvo.includes(` ${buscavel(grafia).trim()} `)) achadas.add(marca);
  }

  return [...achadas];
}

/**
 * Uma célula tem cara de marca?
 *
 * Recusa o que o export já mostrou não ser: `TMAC - 157,11 aolixin` (preço
 * colado na marca) e frases inteiras que o regex da descrição pode capturar.
 */
function pareceMarca(value: string): boolean {
  if (value.length === 0 || value.length > MARCA_MAX) return false;
  if (value.includes(",")) return false;
  if (/\d{3,}/.test(value)) return false;

  return /[A-ZÀ-Ü]{2,}/.test(value);
}

/** Etapa 1 — a coluna `Marca`. */
function daColunaMarca(raw: unknown): string | null {
  const value = cell(raw);

  if (value === null) return null;

  const limpo = canonico(limpar(value));

  if (MARCAS_CONHECIDAS.includes(limpo)) return limpo;

  // Célula suja: se ela cita UMA marca conhecida, é essa. Se cita duas, o
  // arquivo não decide por nós — `TMAC - 157,11 aolixin` cita as duas.
  const citadas = marcasNoTexto(value);

  if (citadas.length === 1) return citadas[0] ?? null;
  if (citadas.length > 1) return null;

  // Marca nova, ainda desconhecida do catálogo: aceita se tiver forma de marca.
  return pareceMarca(limpo) ? limpo : null;
}

/** Etapa 2 — `Categorias`, quando é marca e não hierarquia, número ou status. */
function daCategoria(raw: unknown): string | null {
  const value = cell(raw);

  if (value === null) return null;

  const limpo = limpar(value);

  if (limpo.includes("→") || limpo.includes("->")) return null;
  if (/^\d+$/.test(limpo)) return null;
  if (NAO_E_MARCA.has(limpo)) return null;

  const marca = canonico(limpo);

  return pareceMarca(marca) ? marca : null;
}

/** Etapa 3 — "Marca: Off Racer;" na cópia do anúncio. */
function daDescricao(raw: unknown): string | null {
  const value = cell(raw);

  if (value === null) return null;

  const achado = /marca\s*:\s*([^;\n\r.]{2,60})/i.exec(value);

  if (achado === null) return null;

  const citadas = marcasNoTexto(achado[1] ?? "");

  return citadas.length === 1 ? (citadas[0] ?? null) : null;
}

/** Etapa 4 — a marca escrita no título, ou o prefixo do código do SKU. */
function doTituloOuSku(title: unknown, sku: string): string | null {
  const texto = cell(title);

  if (texto !== null) {
    const citadas = marcasNoTexto(texto);

    if (citadas.length === 1) return citadas[0] ?? null;
  }

  const codigo = buscavel(sku).trim();

  for (const [prefixo, marca] of PREFIXOS_DE_SKU) {
    if (codigo.startsWith(buscavel(prefixo).trim())) return marca;
  }

  return null;
}

/** Etapa 5 — linha de produto conhecida. */
function daLinhaDeProduto(title: unknown): string | null {
  const texto = cell(title);

  if (texto === null) return null;

  const alvo = buscavel(texto);

  for (const [linha, marca] of LINHAS_DE_PRODUTO) {
    if (alvo.includes(` ${linha} `)) return marca;
  }

  return null;
}

/** Etapa 6 — o balde `999`, que o dono declarou Off Racer. */
function doBaldeSemCategoria(raw: unknown): string | null {
  const value = cell(raw);

  return value === null ? null : (BALDE_SEM_CATEGORIA.get(limpar(value)) ?? null);
}

export function resolveSupplierBrand(input: SupplierBrandInput): SupplierBrandResult {
  const daCat = daCategoria(input.categories);

  if (daCat !== null) return { brand: daCat, origin: "CATEGORIA" };

  const daMarca = daColunaMarca(input.brandColumn);

  if (daMarca !== null) return { brand: daMarca, origin: "MARCA" };

  const daDesc = daDescricao(input.description);

  if (daDesc !== null) return { brand: daDesc, origin: "DESCRICAO" };

  const doTitulo = doTituloOuSku(input.title, input.sku);

  if (doTitulo !== null) return { brand: doTitulo, origin: "TITULO" };

  const daLinha = daLinhaDeProduto(input.title);

  if (daLinha !== null) return { brand: daLinha, origin: "LINHA" };

  const doBalde = doBaldeSemCategoria(input.categories);

  if (doBalde !== null) return { brand: doBalde, origin: "BALDE" };

  return SEM_MARCA;
}
