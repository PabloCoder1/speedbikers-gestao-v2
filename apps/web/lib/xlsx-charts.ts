import JSZip from "jszip";

/**
 * Gráficos NATIVOS do Excel num `.xlsx` gerado pelo exceljs (D-424).
 *
 * O exceljs 4 escreve planilha, estilo, imagem e formatação condicional, mas
 * não escreve gráfico. Imagem de gráfico seria estática (não acompanha o
 * filtro de quem abrir) e exigiria renderizar no servidor; o gráfico nativo é
 * só XML (DrawingML), aponta para as células da própria planilha e o Excel o
 * redesenha quando os números mudam.
 *
 * Então o arquivo sai do exceljs e passa por aqui: cada gráfico vira uma parte
 * `xl/charts/chartN.xml`, cada aba com gráfico ganha um `xl/drawings/
 * drawingN.xml` com as âncoras, e as relações e os tipos de conteúdo são
 * registrados. Os valores também vão no cache do gráfico (`numCache`/
 * `strCache`): quem só pré-visualiza o arquivo (celular, e-mail) vê o gráfico
 * sem recalcular nada.
 *
 * A ORDEM dos elementos segue o esquema (ECMA-376, CT_ChartSpace e família):
 * o Excel recusa -- "encontramos um problema" -- elemento fora de ordem. Cada
 * modelo abaixo foi aberto no Excel 16 sem reparo.
 */

export interface ChartSeries {
  name: string;
  /** Referência das categorias, ex.: `'Painel'!$A$10:$A$20`. */
  categoriesRef: string;
  categories: readonly string[];
  /** Referência dos valores, do mesmo tamanho das categorias. */
  valuesRef: string;
  values: readonly (number | null)[];
  /** Hex sem `#`, ex.: `0E1259`. */
  color: string;
  /** Cores por ponto (rosca): uma por categoria. */
  pointColors?: readonly string[];
}

export interface ChartSpec {
  /** Nome da aba (como aparece na guia). */
  sheet: string;
  /** Canto superior esquerdo e inferior direito, em coluna/linha ZERO-based. */
  from: { col: number; row: number };
  to: { col: number; row: number };
  type: "column" | "bar" | "doughnut" | "line" | "pareto";
  title: string;
  stacked?: boolean;
  series: readonly ChartSeries[];
  /** Formato do eixo de valor (o da coluna), ex.: `"R$" #,##0`. */
  valueFormat?: string;
}

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

export function escapeXml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `'Nome da aba'!$A$1:$A$9` a partir de coluna (1-based) e linhas. */
export function rangeRef(sheet: string, col: number, firstRow: number, lastRow: number): string {
  const letra = columnLetter(col);

  return `'${sheet.replace(/'/g, "''")}'!$${letra}$${String(firstRow)}:$${letra}$${String(lastRow)}`;
}

export function columnLetter(col: number): string {
  let n = col;
  let letra = "";

  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = Math.floor((n - 1) / 26);
  }

  return letra;
}

function strRef(ref: string, valores: readonly string[]): string {
  const pts = valores.map((v, i) => `<c:pt idx="${String(i)}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join("");

  return `<c:strRef><c:f>${escapeXml(ref)}</c:f><c:strCache><c:ptCount val="${String(valores.length)}"/>${pts}</c:strCache></c:strRef>`;
}

function numRef(ref: string, valores: readonly (number | null)[]): string {
  // Ponto ausente fica FORA do cache: o gráfico mostra lacuna, nunca zero (D-067).
  const pts = valores
    .map((v, i) => (v === null || !Number.isFinite(v) ? "" : `<c:pt idx="${String(i)}"><c:v>${String(v)}</c:v></c:pt>`))
    .join("");

  return `<c:numRef><c:f>${escapeXml(ref)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${String(valores.length)}"/>${pts}</c:numCache></c:numRef>`;
}

function preenchimento(cor: string): string {
  return `<c:spPr><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill></c:spPr>`;
}

function linha(cor: string): string {
  return `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill><a:round/></a:ln></c:spPr>`;
}

const TEXTO_EIXO =
  '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="4B5563"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr>';

const GRADE =
  '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';

function titulo(texto: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="pt-BR" sz="1200" b="1"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>${escapeXml(texto)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function eixoCategoria(id: number, cruza: number, posicao: "b" | "l", opcoes: { invertido?: boolean; oculto?: boolean } = {}): string {
  return (
    `<c:catAx><c:axId val="${String(id)}"/>` +
    `<c:scaling><c:orientation val="${opcoes.invertido === true ? "maxMin" : "minMax"}"/></c:scaling>` +
    `<c:delete val="${opcoes.oculto === true ? "1" : "0"}"/><c:axPos val="${posicao}"/>` +
    '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>' +
    `<c:tickLblPos val="nextTo"/>${TEXTO_EIXO}<c:crossAx val="${String(cruza)}"/><c:crosses val="autoZero"/>` +
    '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
  );
}

function eixoValor(
  id: number,
  cruza: number,
  posicao: "b" | "l" | "r",
  formato: string,
  opcoes: { grade?: boolean; cruzaNoMaximo?: boolean; maximo?: number } = {},
): string {
  const escala =
    opcoes.maximo === undefined
      ? '<c:scaling><c:orientation val="minMax"/></c:scaling>'
      : `<c:scaling><c:orientation val="minMax"/><c:max val="${String(opcoes.maximo)}"/><c:min val="0"/></c:scaling>`;

  return (
    `<c:valAx><c:axId val="${String(id)}"/>${escala}<c:delete val="0"/><c:axPos val="${posicao}"/>` +
    (opcoes.grade === false ? "" : GRADE) +
    `<c:numFmt formatCode="${escapeXml(formato)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="nextTo"/>${TEXTO_EIXO}<c:crossAx val="${String(cruza)}"/>` +
    `<c:crosses val="${opcoes.cruzaNoMaximo === true ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`
  );
}

function serieDeBarra(serie: ChartSeries, indice: number): string {
  return (
    `<c:ser><c:idx val="${String(indice)}"/><c:order val="${String(indice)}"/>` +
    `<c:tx><c:v>${escapeXml(serie.name)}</c:v></c:tx>${preenchimento(serie.color)}<c:invertIfNegative val="0"/>` +
    `<c:cat>${strRef(serie.categoriesRef, serie.categories)}</c:cat><c:val>${numRef(serie.valuesRef, serie.values)}</c:val></c:ser>`
  );
}

function serieDeLinha(serie: ChartSeries, indice: number): string {
  return (
    `<c:ser><c:idx val="${String(indice)}"/><c:order val="${String(indice)}"/>` +
    `<c:tx><c:v>${escapeXml(serie.name)}</c:v></c:tx>${linha(serie.color)}` +
    `<c:marker><c:symbol val="circle"/><c:size val="4"/>${preenchimento(serie.color)}</c:marker>` +
    `<c:cat>${strRef(serie.categoriesRef, serie.categories)}</c:cat><c:val>${numRef(serie.valuesRef, serie.values)}</c:val>` +
    '<c:smooth val="0"/></c:ser>'
  );
}

function graficoDeBarras(spec: ChartSpec, direcao: "col" | "bar", series: readonly ChartSeries[], eixos: [number, number]): string {
  const empilhado = spec.stacked === true;

  return (
    `<c:barChart><c:barDir val="${direcao}"/><c:grouping val="${empilhado ? "stacked" : "clustered"}"/><c:varyColors val="0"/>` +
    series.map((s, i) => serieDeBarra(s, i)).join("") +
    `<c:gapWidth val="${empilhado ? "50" : "70"}"/>` +
    (empilhado ? '<c:overlap val="100"/>' : "") +
    `<c:axId val="${String(eixos[0])}"/><c:axId val="${String(eixos[1])}"/></c:barChart>`
  );
}

const LEGENDA =
  '<c:legend><c:legendPos val="b"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr></c:legend>';

function areaDoGrafico(spec: ChartSpec): { plot: string; legenda: boolean } {
  const formato = spec.valueFormat ?? "#,##0";

  switch (spec.type) {
    case "column":
      return {
        plot: graficoDeBarras(spec, "col", spec.series, [101, 102]) + eixoCategoria(101, 102, "b") + eixoValor(102, 101, "l", formato),
        legenda: spec.series.length > 1,
      };
    case "bar":
      // Barra horizontal com o maior em cima: categorias invertidas e o eixo
      // de valor cruzando no "máximo" (que, invertido, é embaixo).
      return {
        plot:
          graficoDeBarras(spec, "bar", spec.series, [101, 102]) +
          eixoCategoria(101, 102, "l", { invertido: true }) +
          eixoValor(102, 101, "b", formato, { cruzaNoMaximo: true }),
        legenda: spec.series.length > 1,
      };
    case "line":
      return {
        plot:
          '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
          spec.series.map((s, i) => serieDeLinha(s, i)).join("") +
          '<c:marker val="1"/><c:axId val="101"/><c:axId val="102"/></c:lineChart>' +
          eixoCategoria(101, 102, "b") +
          eixoValor(102, 101, "l", formato),
        legenda: spec.series.length > 1,
      };
    case "pareto": {
      // Colunas (1ª série) no eixo principal; a linha do acumulado (2ª série,
      // fração 0..1) no eixo secundário à direita, de 0% a 100%.
      const [colunas, acumulado] = spec.series;

      if (colunas === undefined || acumulado === undefined) {
        throw new Error("gráfico de Pareto precisa de duas séries");
      }

      return {
        plot:
          graficoDeBarras({ ...spec, stacked: false }, "col", [colunas], [101, 102]) +
          '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
          serieDeLinha(acumulado, 1) +
          '<c:marker val="1"/><c:axId val="103"/><c:axId val="104"/></c:lineChart>' +
          eixoCategoria(101, 102, "b") +
          eixoValor(102, 101, "l", formato) +
          eixoCategoria(103, 104, "b", { oculto: true }) +
          eixoValor(104, 103, "r", "0%", { grade: false, cruzaNoMaximo: true, maximo: 1 }),
        legenda: true,
      };
    }
    case "doughnut": {
      const [serie] = spec.series;

      if (serie === undefined) throw new Error("gráfico de rosca precisa de uma série");

      const pontos = (serie.pointColors ?? [])
        .map((cor, i) => `<c:dPt><c:idx val="${String(i)}"/><c:bubble3D val="0"/>${preenchimento(cor)}</c:dPt>`)
        .join("");
      const rotulos =
        '<c:dLbls><c:numFmt formatCode="0.0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
        '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr>' +
        '<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>';

      return {
        plot:
          '<c:doughnutChart><c:varyColors val="1"/>' +
          `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${escapeXml(serie.name)}</c:v></c:tx>${pontos}${rotulos}` +
          `<c:cat>${strRef(serie.categoriesRef, serie.categories)}</c:cat><c:val>${numRef(serie.valuesRef, serie.values)}</c:val></c:ser>` +
          '<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>',
        legenda: true,
      };
    }
  }
}

export function chartXml(spec: ChartSpec): string {
  const { plot, legenda } = areaDoGrafico(spec);

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<c:roundedCorners val="0"/>' +
    `<c:chart>${titulo(spec.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>` +
    (legenda ? LEGENDA : "") +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr>' +
    "</c:chartSpace>"
  );
}

function ancora(spec: ChartSpec, indice: number): string {
  return (
    '<xdr:twoCellAnchor editAs="oneCell">' +
    `<xdr:from><xdr:col>${String(spec.from.col)}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${String(spec.from.row)}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${String(spec.to.col)}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${String(spec.to.row)}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${String(indice + 2)}" name="${escapeXml(spec.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="rId${String(indice + 1)}"/></a:graphicData></a:graphic>` +
    "</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>"
  );
}

/** Elementos que vêm DEPOIS de `<drawing>` em CT_Worksheet: o `<drawing>` entra antes do primeiro deles. */
const DEPOIS_DO_DRAWING = [
  "<legacyDrawing",
  "<legacyDrawingHF",
  "<drawingHF",
  "<picture",
  "<oleObjects",
  "<controls",
  "<webPublishItems",
  "<tableParts",
  "<extLst",
  "</worksheet>",
];

function inserirDrawing(sheetXml: string, relId: string): string {
  if (sheetXml.includes("<drawing ")) {
    throw new Error("a aba já tem desenho: os gráficos precisam de uma aba sem imagem");
  }

  const posicoes = DEPOIS_DO_DRAWING.map((tag) => sheetXml.indexOf(tag)).filter((p) => p >= 0);
  const onde = Math.min(...posicoes);

  return `${sheetXml.slice(0, onde)}<drawing r:id="${relId}"/>${sheetXml.slice(onde)}`;
}

async function lerTexto(zip: JSZip, caminho: string): Promise<string | null> {
  const arquivo = zip.file(caminho);

  return arquivo === null ? null : arquivo.async("string");
}

/** Acrescenta os gráficos ao `.xlsx` e devolve o arquivo novo. */
export async function addChartsToXlsx(xlsx: ArrayBuffer | Uint8Array, charts: readonly ChartSpec[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(xlsx);

  if (charts.length === 0) return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

  const workbook = await lerTexto(zip, "xl/workbook.xml");
  const workbookRels = await lerTexto(zip, "xl/_rels/workbook.xml.rels");
  let contentTypes = await lerTexto(zip, "[Content_Types].xml");

  if (workbook === null || workbookRels === null || contentTypes === null) {
    throw new Error("xlsx sem workbook, relações ou tipos de conteúdo");
  }

  const porAba = new Map<string, ChartSpec[]>();

  for (const chart of charts) {
    porAba.set(chart.sheet, [...(porAba.get(chart.sheet) ?? []), chart]);
  }

  const desenhosExistentes = Object.keys(zip.files).filter((f) => /^xl\/drawings\/drawing\d+\.xml$/.test(f)).length;
  const graficosExistentes = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).length;
  let proximoDesenho = desenhosExistentes + 1;
  let proximoGrafico = graficosExistentes + 1;

  for (const [aba, specs] of porAba) {
    const nomeXml = escapeXml(aba);
    const sheetTag = new RegExp(`<sheet [^>]*name="${nomeXml.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`).exec(workbook);
    const relId = sheetTag === null ? null : /r:id="([^"]+)"/.exec(sheetTag[0])?.[1];

    if (relId === undefined || relId === null) throw new Error(`aba ${aba} não encontrada`);

    const alvo = new RegExp(`<Relationship [^>]*Id="${relId}"[^>]*/>`).exec(workbookRels)?.[0];
    const target = alvo === undefined ? undefined : /Target="([^"]+)"/.exec(alvo)?.[1];

    if (target === undefined) throw new Error(`relação da aba ${aba} não encontrada`);

    const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const sheetNome = sheetPath.split("/").pop() ?? "";
    const sheetRelsPath = `xl/worksheets/_rels/${sheetNome}.rels`;
    const sheetXml = await lerTexto(zip, sheetPath);

    if (sheetXml === null) throw new Error(`xml da aba ${aba} não encontrado`);

    const drawingNum = proximoDesenho;
    proximoDesenho += 1;

    // A relação aba -> desenho, com um Id que não colide com as que já existem.
    const relsExistente =
      (await lerTexto(zip, sheetRelsPath)) ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}"></Relationships>`;
    let novoRel = 1;

    while (relsExistente.includes(`Id="rIdChart${String(novoRel)}"`)) novoRel += 1;

    const relDoDesenho = `rIdChart${String(novoRel)}`;
    zip.file(
      sheetRelsPath,
      relsExistente.replace(
        "</Relationships>",
        `<Relationship Id="${relDoDesenho}" Type="${REL_DRAWING}" Target="../drawings/drawing${String(drawingNum)}.xml"/></Relationships>`,
      ),
    );
    zip.file(sheetPath, inserirDrawing(sheetXml, relDoDesenho));

    const relsDoDesenho: string[] = [];
    const ancoras: string[] = [];

    specs.forEach((spec, indice) => {
      const chartNum = proximoGrafico;
      proximoGrafico += 1;
      zip.file(`xl/charts/chart${String(chartNum)}.xml`, chartXml(spec));
      relsDoDesenho.push(
        `<Relationship Id="rId${String(indice + 1)}" Type="${REL_CHART}" Target="../charts/chart${String(chartNum)}.xml"/>`,
      );
      ancoras.push(ancora(spec, indice));
      contentTypes = (contentTypes ?? "").replace(
        "</Types>",
        `<Override PartName="/xl/charts/chart${String(chartNum)}.xml" ContentType="${CT_CHART}"/></Types>`,
      );
    });

    zip.file(
      `xl/drawings/drawing${String(drawingNum)}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${ancoras.join("")}</xdr:wsDr>`,
    );
    zip.file(
      `xl/drawings/_rels/drawing${String(drawingNum)}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}">${relsDoDesenho.join("")}</Relationships>`,
    );
    contentTypes = contentTypes.replace(
      "</Types>",
      `<Override PartName="/xl/drawings/drawing${String(drawingNum)}.xml" ContentType="${CT_DRAWING}"/></Types>`,
    );
  }

  zip.file("[Content_Types].xml", contentTypes);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
