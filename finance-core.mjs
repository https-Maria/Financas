/* Dueto — regras financeiras puras e testáveis.
 * Nenhuma função altera registros, acessa o banco ou depende do relógio global.
 */
const VALIDA_COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/;
const CENTAVOS = valor => Math.round((Number(valor) || 0) * 100);

function somarMeses(mes, quantidade) {
  if (!VALIDA_COMPETENCIA.test(String(mes))) return null;
  const [ano, mesNumero] = mes.split('-').map(Number);
  const total = ano * 12 + (mesNumero - 1) + quantidade;
  const novoAno = Math.floor(total / 12);
  const novoMes = ((total % 12) + 12) % 12 + 1;
  return novoAno + '-' + String(novoMes).padStart(2, '0');
}

export function mesesDaParcela(p, mesAtual) {
  const restantes = Math.max(0, Math.trunc(Number(p?.restantes) || 0));
  if (!restantes) return [];
  if (Array.isArray(p?.competencias) && p.competencias.length) {
    // A sequência cadastrada é a fonte da verdade, mesmo com meses pulados.
    return p.competencias.filter(m => VALIDA_COMPETENCIA.test(String(m))).slice(0, restantes);
  }
  const inicio = String(p?.primeira_fatura || '').slice(0, 7);
  const base = VALIDA_COMPETENCIA.test(inicio) ? inicio : mesAtual;
  if (!VALIDA_COMPETENCIA.test(String(base))) return [];
  return Array.from({ length: restantes }, (_, i) => somarMeses(base, i));
}

export function parcelaCaiEm(p, competencia, mesAtual) {
  return mesesDaParcela(p, mesAtual).includes(competencia);
}

export function parcelasMes(parcelamentos, competencia, extra, mesAtual) {
  const lista = [...(parcelamentos || []), ...(extra ? [extra] : [])];
  const total = lista.reduce((centavos, p) =>
    centavos + (parcelaCaiEm(p, competencia, mesAtual) ? CENTAVOS(p.valor_parcela) : 0), 0);
  return total / 100;
}

export function lancamentoPertenceAoCiclo(lancamento, competencia, janela, competenciaCongelada = null) {
  // Ajuste que já integra uma fotografia não pode migrar para outra fatura.
  if (competenciaCongelada) return competenciaCongelada === competencia;
  const informada = String(lancamento?.competencia_fatura || '');
  if (VALIDA_COMPETENCIA.test(informada)) return informada === competencia;
  if (janela?.ini && janela?.fim) {
    const data = String(lancamento?.data || '');
    return data > janela.ini && data <= janela.fim;
  }
  // Sem calendário do cartão, não inventar uma janela: usar mês civil.
  return String(lancamento?.data || '').slice(0, 7) === competencia;
}

export function mesDeCaixa(lancamento, venceDiaUm) {
  const data = String(lancamento?.data || '');
  const competencia = data.slice(0, 7);
  const ehPagamento = lancamento?.cartao &&
    lancamento?.categoria === 'Cartão' && lancamento?.tipo === 'Saída';
  return ehPagamento && venceDiaUm && data.slice(8, 10) === '01'
    ? somarMeses(competencia, -1) || competencia : competencia;
}

const CATEGORIAS_NEUTRAS = new Set([
  'transferência interna', 'terceiros', 'reembolso terceiros', 'reembolso'
]);
export function categoriaNeutra(categoria) {
  return CATEGORIAS_NEUTRAS.has(String(categoria || '').trim().toLocaleLowerCase('pt-BR'));
}

export function movimentoOrcamentario(lancamento) {
  if (!lancamento || lancamento.protegido || lancamento.beneficio ||
      categoriaNeutra(lancamento.categoria)) return false;
  // Compra no cartão não é saída do caixa; só o pagamento da fatura é.
  if (lancamento.cartao) {
    return lancamento.categoria === 'Cartão' && lancamento.tipo === 'Saída';
  }
  return true;
}

export function repartirFatura({ banco = null, terceiros = 0, reports = 0,
                                 modelado = 0, forcado = null } = {}) {
  const totalBanco = banco == null ? null : CENTAVOS(banco);
  const valorTerceiros = CENTAVOS(terceiros);
  const valorReports = CENTAVOS(reports);
  const parte = forcado != null ? CENTAVOS(forcado)
    : totalBanco != null ? Math.max(0, totalBanco - valorTerceiros - valorReports)
    : CENTAVOS(modelado);
  if (totalBanco != null && Math.abs(parte + valorTerceiros + valorReports - totalBanco) > 1) {
    return { erro: 'Total do banco incompatível com a divisão entre casal, terceiros e Reports.' };
  }
  return {
    sua_parte: parte / 100,
    total_real: (totalBanco == null ? parte + valorTerceiros + valorReports : totalBanco) / 100,
    fonte: totalBanco == null ? (forcado == null ? 'modelado' : 'manual') : 'banco'
  };
}
