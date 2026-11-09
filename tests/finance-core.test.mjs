import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mesesDaParcela, parcelaCaiEm, parcelasMes, lancamentoPertenceAoCiclo,
  mesDeCaixa, categoriaNeutra, movimentoOrcamentario, repartirFatura
} from '../finance-core.mjs';

test('parcelamento respeita competências reais, inclusive mês pulado', () => {
  const p = {valor_parcela:399.67, primeira_fatura:'2026-10-01', restantes:2,
    competencias:['2026-11','2026-12']};
  assert.deepEqual(mesesDaParcela(p,'2026-11'), ['2026-11','2026-12']);
  assert.equal(parcelaCaiEm(p,'2026-10','2026-11'), false);
  assert.equal(parcelasMes([p],'2026-12',null,'2026-11'), 399.67);
});
test('parcelas quitadas não reaparecem por competência residual', () => {
  assert.deepEqual(mesesDaParcela({restantes:0,competencias:['2026-12']},'2026-11'), []);
});
test('anuidade com competência novembro não cai em dezembro', () => {
  const p = {valor_parcela:17.50, restantes:5, primeira_fatura:'2026-12-01',
    competencias:['2026-11','2027-01','2027-02','2027-03','2027-04']};
  assert.equal(parcelasMes([p],'2026-11',null,'2026-11'),17.50);
  assert.equal(parcelasMes([p],'2026-12',null,'2026-11'),0);
});
test('fallback mensal funciona quando não existe lista de competências', () => {
  assert.deepEqual(mesesDaParcela({primeira_fatura:'2026-12-01',restantes:3},'2026-11'),
    ['2026-12','2027-01','2027-02']);
});
test('ajuste sem competência segue janela do ciclo e não o mês civil', () => {
  const l={data:'2026-10-31'};
  const janela={ini:'2026-10-26',fim:'2026-11-23'};
  assert.equal(lancamentoPertenceAoCiclo(l,'2026-12',janela),true);
  assert.equal(lancamentoPertenceAoCiclo(l,'2026-10',janela),false);
});
test('competência explícita prevalece sobre data e janela', () => {
  assert.equal(lancamentoPertenceAoCiclo({data:'2026-10-31',competencia_fatura:'2026-10'},
    '2026-12',{ini:'2026-10-26',fim:'2026-11-23'}),false);
});
test('dia 1 desloca pagamento da fatura, não compra com cartão', () => {
  const base={cartao:'BB Jéssica',data:'2026-10-01',tipo:'Saída'};
  assert.equal(mesDeCaixa({...base,categoria:'Cartão'},true),'2026-09');
  assert.equal(mesDeCaixa({...base,categoria:'Compras'},true),'2026-10');
});
test('movimento de orçamento não duplica compras e pagamentos', () => {
  assert.equal(movimentoOrcamentario({cartao:'BB Visa',categoria:'Compras',tipo:'Saída'}),false);
  assert.equal(movimentoOrcamentario({cartao:'BB Visa',categoria:'Cartão',tipo:'Saída'}),true);
  assert.equal(movimentoOrcamentario({categoria:'Mercado',tipo:'Saída'}),true);
});
test('transferências e reembolsos de terceiros não são receita ou despesa', () => {
  for(const categoria of ['Transferência interna','Terceiros','Reembolso Terceiros','Reembolso']){
    assert.equal(categoriaNeutra(categoria),true);
    assert.equal(movimentoOrcamentario({categoria,tipo:'Entrada'}),false);
    assert.equal(movimentoOrcamentario({categoria,tipo:'Saída'}),false);
  }
});
test('total bancário prevalece na fotografia de fatura', () => {
  assert.deepEqual(repartirFatura({banco:1251.67,terceiros:471.57,reports:0,modelado:999}),
    {sua_parte:780.10,total_real:1251.67,fonte:'banco'});
});
test('inconsistência entre total e divisão bloqueia fotografia incorreta', () => {
  assert.match(repartirFatura({banco:100,terceiros:150,modelado:30}).erro,/incompatível/);
});
test('valor forçado pelo painel não pode divergir do banco', () => {
  assert.match(repartirFatura({banco:100,terceiros:20,forcado:90}).erro,/incompatível/);
});
