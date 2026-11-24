import { COLUNAS_MAXIMAS, LINHAS_MAXIMAS_POR_ABA, moedaDoFormato, type Aba, type Celula } from "./xlsx";

/**
 * Leitura mínima do .xls antigo (Excel 97–2003, BIFF8) para a importação
 * (D-767). Fornecedores ainda mandam proforma nesse formato.
 *
 * O .xls é um "compound file" (um mini sistema de arquivos em setores) com um
 * fluxo "Workbook" de registros BIFF. Daqui só saem os nomes das abas, a
 * tabela de textos (SST) e os registros de célula — números, textos e o valor
 * já calculado das fórmulas. Imagens, formatação e macros são outros fluxos e
 * outros registros: nunca são interpretados. Arquivo protegido por senha ou de
 * versão anterior ao Excel 97 é recusado com mensagem clara.
 */

const ASSINATURA = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FIM_DE_CADEIA = 0xfffffffe;
const LIVRE = 0xffffffff;

export class XlsInvalido extends Error {}

function letraDaColuna(indice: number): string {
  let n = indice + 1;
  let s = "";

  while (n > 0) {
    const r = (n - 1) % 26;

    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }

  return s;
}

/** O fluxo "Workbook" (ou "Book") de dentro do compound file. */
export function fluxoDoWorkbook(dados: Uint8Array): Uint8Array {
  if (dados.length < 512 || ASSINATURA.some((b, i) => dados[i] !== b)) {
    throw new XlsInvalido("O arquivo não é um .xls do Excel.");
  }

  const dv = new DataView(dados.buffer, dados.byteOffset, dados.byteLength);
  const tamSetor = 1 << dv.getUint16(0x1e, true);
  const tamMini = 1 << dv.getUint16(0x20, true);
  const setoresFat = dv.getUint32(0x2c, true);
  const primeiroDir = dv.getUint32(0x30, true);
  const corteMini = dv.getUint32(0x38, true);
  const primeiroMiniFat = dv.getUint32(0x3c, true);
  let difat = dv.getUint32(0x44, true);
  const totalSetores = Math.floor((dados.length - tamSetor) / tamSetor) + 1;

  if (tamSetor !== 512 && tamSetor !== 4096) throw new XlsInvalido("Setor de tamanho inesperado no .xls.");

  const offset = (s: number): number => (s + 1) * tamSetor;
  const u32 = (pos: number): number => (pos + 4 <= dados.length ? dv.getUint32(pos, true) : LIVRE);

  // Os setores da FAT: 109 no cabeçalho, o resto na cadeia DIFAT.
  const setoresDaFat: number[] = [];

  for (let i = 0; i < 109 && setoresDaFat.length < setoresFat; i += 1) setoresDaFat.push(u32(0x4c + i * 4));

  for (let guarda = 0; difat !== FIM_DE_CADEIA && difat !== LIVRE && setoresDaFat.length < setoresFat && guarda < totalSetores; guarda += 1) {
    const base = offset(difat);

    for (let i = 0; i < tamSetor / 4 - 1 && setoresDaFat.length < setoresFat; i += 1) setoresDaFat.push(u32(base + i * 4));
    difat = u32(base + tamSetor - 4);
  }

  const fat: number[] = [];

  for (const s of setoresDaFat) {
    const base = offset(s);

    for (let i = 0; i < tamSetor / 4; i += 1) fat.push(u32(base + i * 4));
  }

  const cadeia = (inicio: number, tabela: readonly number[]): number[] => {
    const saida: number[] = [];
    const vistos = new Set<number>();

    for (let s = inicio; s !== FIM_DE_CADEIA && s !== LIVRE && s < tabela.length; s = tabela[s] ?? FIM_DE_CADEIA) {
      if (vistos.has(s)) throw new XlsInvalido("Cadeia de setores circular no .xls.");
      vistos.add(s);
      saida.push(s);
    }

    return saida;
  };
  const ler = (inicio: number, tamanho: number): Uint8Array => {
    const saida = new Uint8Array(tamanho);
    let pos = 0;

    for (const s of cadeia(inicio, fat)) {
      if (pos >= tamanho) break;
      const pedaco = dados.subarray(offset(s), Math.min(offset(s) + tamSetor, dados.length)).subarray(0, tamanho - pos);

      saida.set(pedaco, pos);
      pos += pedaco.length;
    }

    return saida;
  };

  // O diretório: entradas de 128 bytes.
  const diretorio = cadeia(primeiroDir, fat).flatMap((s) => {
    const base = offset(s);

    return Array.from({ length: tamSetor / 128 }, (_, i) => base + i * 128);
  });
  let raiz: { inicio: number; tamanho: number } | null = null;
  let livro: { inicio: number; tamanho: number } | null = null;

  for (const e of diretorio) {
    if (e + 128 > dados.length) continue;
    const tamNome = dv.getUint16(e + 64, true);
    const tipo = dados[e + 66];
    let nome = "";

    for (let i = 0; i + 2 < tamNome && i < 64; i += 2) nome += String.fromCharCode(dv.getUint16(e + i, true));

    const entrada = { inicio: dv.getUint32(e + 116, true), tamanho: dv.getUint32(e + 120, true) };

    if (tipo === 5) raiz = entrada;
    else if (tipo === 2 && (nome === "Workbook" || nome === "Book") && livro === null) livro = entrada;
    else if (tipo === 2 && nome === "EncryptedPackage") throw new XlsInvalido("O arquivo está protegido por senha.");
  }

  if (livro === null) throw new XlsInvalido("O .xls não tem a pasta de trabalho (fluxo Workbook).");
  if (livro.tamanho > 64 * 1024 * 1024) throw new XlsInvalido("A pasta de trabalho do .xls é grande demais.");

  if (livro.tamanho >= corteMini || raiz === null) return ler(livro.inicio, livro.tamanho);

  // Fluxo pequeno: mora no mini fluxo, endereçado pela mini FAT.
  const miniFat: number[] = [];

  for (const s of cadeia(primeiroMiniFat, fat)) {
    const base = offset(s);

    for (let i = 0; i < tamSetor / 4; i += 1) miniFat.push(u32(base + i * 4));
  }

  const mini = ler(raiz.inicio, raiz.tamanho);
  const saida = new Uint8Array(livro.tamanho);
  let pos = 0;

  for (const s of cadeia(livro.inicio, miniFat)) {
    if (pos >= livro.tamanho) break;
    const pedaco = mini.subarray(s * tamMini, s * tamMini + tamMini).subarray(0, livro.tamanho - pos);

    saida.set(pedaco, pos);
    pos += pedaco.length;
  }

  return saida;
}

interface Registro {
  readonly tipo: number;
  readonly dados: Uint8Array;
  readonly pos: number;
}

function registros(fluxo: Uint8Array): Registro[] {
  const saida: Registro[] = [];
  const dv = new DataView(fluxo.buffer, fluxo.byteOffset, fluxo.byteLength);

  for (let pos = 0; pos + 4 <= fluxo.length; ) {
    const tipo = dv.getUint16(pos, true);
    const tam = dv.getUint16(pos + 2, true);

    saida.push({ tipo, dados: fluxo.subarray(pos + 4, Math.min(pos + 4 + tam, fluxo.length)), pos });
    pos += 4 + tam;
  }

  return saida;
}

/**
 * Leitor de texto BIFF8 sobre um registro e os CONTINUE que o seguem. No
 * começo de cada CONTINUE, um texto que estava sendo lido recomeça com um byte
 * de opção que diz se os caracteres seguintes são de 1 ou 2 bytes.
 */
class LeitorContinuo {
  private parte = 0;
  private pos = 0;

  constructor(private readonly partes: readonly Uint8Array[]) {}

  private atual(): Uint8Array | undefined {
    while (this.parte < this.partes.length && this.pos >= (this.partes[this.parte]?.length ?? 0)) {
      this.parte += 1;
      this.pos = 0;
    }

    return this.partes[this.parte];
  }

  fim(): boolean {
    return this.atual() === undefined;
  }

  byte(): number {
    const p = this.atual();

    if (p === undefined) throw new XlsInvalido("Texto do .xls cortado.");

    const b = p[this.pos] ?? 0;

    this.pos += 1;

    return b;
  }

  u16(): number {
    return this.byte() | (this.byte() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  pular(n: number): void {
    for (let i = 0; i < n; i += 1) this.byte();
  }

  /** XLUnicodeRichExtendedString: o texto de uma entrada da SST (ou de LABEL/STRING). */
  texto(tamanhoEm16 = true): string {
    const cch = tamanhoEm16 ? this.u16() : this.byte();
    let opcoes = this.byte();
    const rico = (opcoes & 0x08) !== 0 ? this.u16() : 0;
    const extra = (opcoes & 0x04) !== 0 ? this.u32() : 0;
    let saida = "";

    for (let i = 0; i < cch; i += 1) {
      if (this.pos >= (this.partes[this.parte]?.length ?? 0) && this.parte + 1 < this.partes.length) {
        // Caracteres continuam no próximo CONTINUE, com um novo byte de opção.
        this.parte += 1;
        this.pos = 0;
        opcoes = this.byte();
      }

      saida += String.fromCharCode((opcoes & 0x01) !== 0 ? this.u16() : this.byte());
    }

    this.pular(rico * 4 + extra);

    return saida;
  }
}

function numeroRk(rk: number): number {
  let v: number;

  if ((rk & 0x02) !== 0) {
    v = rk >> 2;
  } else {
    const b = new DataView(new ArrayBuffer(8));

    b.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    b.setUint32(0, 0, true);
    v = b.getFloat64(0, true);
  }

  return (rk & 0x01) !== 0 ? v / 100 : v;
}

function textoDoNumero(n: number): string {
  // O mesmo que o .xlsx grava em <v>: o número sem formatação.
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15)));
}

/** Os registros BIFF8 → as abas, no mesmo formato do leitor de .xlsx. */
export function lerBiff(fluxo: Uint8Array, abasEscolhidas?: readonly string[]): { abas: Aba[]; todas: string[] } {
  const regs = registros(fluxo);
  const primeiro = regs[0];

  if (primeiro?.tipo !== 0x0809 || primeiro.dados.length < 2 || ((primeiro.dados[0] ?? 0) | ((primeiro.dados[1] ?? 0) << 8)) !== 0x0600) {
    throw new XlsInvalido("Este .xls é de uma versão antiga do Excel. Abra e salve como .xlsx.");
  }

  const folhas: { nome: string; pos: number }[] = [];
  let sst: string[] = [];
  // FORMAT (id → código) e XF (estilo → id do formato), na ordem do arquivo:
  // dão a moeda que o formato numérico da célula declara.
  const formatos = new Map<number, string>();
  const formatoPorXf: number[] = [];

  for (let i = 0; i < regs.length; i += 1) {
    const r = regs[i];

    if (r === undefined) continue;
    if (r.tipo === 0x000a) break;
    if (r.tipo === 0x002f) throw new XlsInvalido("O arquivo está protegido por senha.");

    if (r.tipo === 0x0085 && r.dados.length >= 8) {
      const dv = new DataView(r.dados.buffer, r.dados.byteOffset, r.dados.byteLength);
      const tipoFolha = r.dados[5];
      const leitor = new LeitorContinuo([r.dados.subarray(6)]);

      if (tipoFolha === 0) folhas.push({ nome: leitor.texto(false), pos: dv.getUint32(0, true) });
    }

    if (r.tipo === 0x041e && r.dados.length >= 5) {
      const id = (r.dados[0] ?? 0) | ((r.dados[1] ?? 0) << 8);

      formatos.set(id, new LeitorContinuo([r.dados.subarray(2)]).texto());
    }

    if (r.tipo === 0x00e0 && r.dados.length >= 4) formatoPorXf.push((r.dados[2] ?? 0) | ((r.dados[3] ?? 0) << 8));

    if (r.tipo === 0x00fc) {
      const partes = [r.dados];

      for (let j = i + 1; regs[j]?.tipo === 0x003c; j += 1) partes.push(regs[j]?.dados ?? new Uint8Array());

      const leitor = new LeitorContinuo(partes);

      leitor.pular(4);

      const unicas = leitor.u32();

      sst = [];
      for (let k = 0; k < unicas && !leitor.fim(); k += 1) sst.push(leitor.texto());
    }
  }

  const moedaPorXf = formatoPorXf.map((id) => {
    const codigo = formatos.get(id);

    return codigo === undefined ? null : moedaDoFormato(codigo);
  });
  /** O número com a moeda do formato do estilo `xf`, quando o formato declara uma. */
  const numero = (texto: string, xf: number): Celula => {
    const moeda = moedaPorXf[xf];

    return typeof moeda === "string" ? { texto, formula: null, numerica: true, moeda } : { texto, formula: null, numerica: true };
  };
  const indicePorPos = new Map(regs.map((r, i) => [r.pos, i]));
  const abas: Aba[] = [];

  for (const folha of folhas) {
    if (abasEscolhidas !== undefined && !abasEscolhidas.includes(folha.nome)) continue;

    const inicio = indicePorPos.get(folha.pos);

    if (inicio === undefined) continue;

    const grade = new Map<number, Map<string, Celula>>();
    let cortada = false;
    let formulaPendente: { linha: number; coluna: number } | null = null;
    const por = (linha: number, coluna: number, celula: Celula): void => {
      if (linha >= LINHAS_MAXIMAS_POR_ABA || coluna >= COLUNAS_MAXIMAS) {
        cortada = true;

        return;
      }

      if (celula.texto === "") return;

      const l = grade.get(linha + 1) ?? new Map<string, Celula>();

      l.set(letraDaColuna(coluna), celula);
      grade.set(linha + 1, l);
    };

    for (let i = inicio + 1; i < regs.length; i += 1) {
      const r = regs[i];

      if (r === undefined || r.tipo === 0x000a) break;

      const d = r.dados;
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const linha = d.length >= 4 ? dv.getUint16(0, true) : 0;
      const coluna = d.length >= 4 ? dv.getUint16(2, true) : 0;

      if (r.tipo === 0x00fd && d.length >= 10) {
        por(linha, coluna, { texto: sst[dv.getUint32(6, true)] ?? "", formula: null, numerica: false });
      } else if (r.tipo === 0x0203 && d.length >= 14) {
        por(linha, coluna, numero(textoDoNumero(dv.getFloat64(6, true)), dv.getUint16(4, true)));
      } else if (r.tipo === 0x027e && d.length >= 10) {
        por(linha, coluna, numero(textoDoNumero(numeroRk(dv.getUint32(6, true))), dv.getUint16(4, true)));
      } else if (r.tipo === 0x00bd && d.length >= 6) {
        const ultima = dv.getUint16(d.length - 2, true);

        for (let c = coluna, p = 4; c <= ultima && p + 6 <= d.length - 2; c += 1, p += 6) {
          por(linha, c, numero(textoDoNumero(numeroRk(dv.getUint32(p + 2, true))), dv.getUint16(p, true)));
        }
      } else if (r.tipo === 0x0204 && d.length >= 8) {
        por(linha, coluna, { texto: new LeitorContinuo([d.subarray(6)]).texto(), formula: null, numerica: false });
      } else if (r.tipo === 0x0006 && d.length >= 20) {
        // Fórmula: só o valor que o Excel guardou. Texto vem no registro STRING seguinte.
        if (dv.getUint16(12, true) === 0xffff) {
          const tipoValor = d[6];

          if (tipoValor === 0) formulaPendente = { linha, coluna };
          else if (tipoValor === 1) por(linha, coluna, { texto: d[8] === 1 ? "TRUE" : "FALSE", formula: null, numerica: false });
        } else {
          por(linha, coluna, numero(textoDoNumero(dv.getFloat64(6, true)), dv.getUint16(4, true)));
        }
      } else if (r.tipo === 0x0207 && formulaPendente !== null) {
        por(formulaPendente.linha, formulaPendente.coluna, { texto: new LeitorContinuo([d]).texto(), formula: null, numerica: false });
        formulaPendente = null;
      } else if (r.tipo === 0x0205 && d.length >= 8 && d[7] === 0) {
        por(linha, coluna, { texto: d[6] === 1 ? "TRUE" : "FALSE", formula: null, numerica: false });
      }
    }

    abas.push({ nome: folha.nome, grade, cortada });
  }

  return { abas, todas: folhas.map((f) => f.nome) };
}

export function lerXls(dados: Uint8Array, abasEscolhidas?: readonly string[]): { abas: Aba[]; todas: string[] } {
  return lerBiff(fluxoDoWorkbook(dados), abasEscolhidas);
}
