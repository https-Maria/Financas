import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * Smoke test das 19 telas: renderização das views sem rede ou banco.
 * Executa a versão real de app.js e finance-core.mjs com ambiente
 * de navegação mínimo e dados demonstrativos estritamente fictícios.
 * Não testa CSS, cliques ou login real (ver tests/ui-smoke.spec.mjs).
 */
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  .replace(/^import \{ createClient \} from [^\n]+\n/, '')
  .replace(/^import \{[\s\S]+?\} from '\.\/finance-core\.mjs\?v=113\.0';\n/, '')
  .replace(/^import \{[\s\S]+?\} from '\.\/notas-editor\.mjs\?v=114\.0';\n/, '')
  .replace(/\niniciar\(\);\s*$/, '\n');

let core = readFileSync(new URL('../finance-core.mjs', import.meta.url), 'utf8')
  .replaceAll('export function', 'function');

const notas = readFileSync(new URL('../notas-editor.mjs', import.meta.url), 'utf8')
  .replaceAll('export function','function').replaceAll('export const','const');

const names = [
  'mesesDaParcela', 'parcelaCaiEm', 'parcelasMes',
  'lancamentoPertenceAoCiclo', 'mesDeCaixa', 'categoriaNeutra',
  'movimentoOrcamentario', 'repartirFatura', 'totalComposicaoFatura'
];
for (const name of names) {
  core = core.replace(new RegExp('\\b' + name + '\\b', 'g'), 'C_' + name);
}
const aliases = String.raw`
const mesesDaParcelaCore=C_mesesDaParcela, parcelaCaiEmCore=C_parcelaCaiEm,
  parcelasMesCore=C_parcelasMes, lancamentoPertenceAoCiclo=C_lancamentoPertenceAoCiclo,
  mesDeCaixaCore=C_mesDeCaixa, categoriaNeutra=C_categoriaNeutra,
  movimentoOrcamentario=C_movimentoOrcamentario, repartirFatura=C_repartirFatura,
  totalComposicaoFatura=C_totalComposicaoFatura;`;

const titles = {
  painel: 'Painel', extrato: 'Extrato', lanc: 'Lançamentos',
  fatura: 'Fatura', parc: 'Parcelamentos', assin: 'Assinaturas',
  terc: 'Terceiros', dash: 'Dashboard', proj: 'Projeção',
  compra: 'Nova compra', cal: 'Calendário', amort: 'Amortização',
  casa: 'Projeções Casa', cad: 'Cadastros', metas: 'Metas',
  backup: 'Cópias', log: 'Atividade',
  integridade: 'Integridade dos dados', notas: 'Bloco de notas'
};

const script = String.raw`
D=criarDadosDemo(); DEMO_MODE=true; GRUPO='grupo-qa-ficticio';
EU='Pessoa QA'; FALTANDO=[];
const resultado=[];
for (const mes of ['2026-10','2026-11','2026-12','2027-01']) {
  MREF=mes;
  for (const [id,titulo] of Object.entries(titles)) {
    try {
      const html=VIEWS[id]();
      if (typeof html !== 'string' || html.length < 40 ||
          !html.includes(titulo)) throw new Error('View sem conteúdo/título');
      resultado.push({ id, mes, ok: true });
    } catch (e) {
      resultado.push({ id, mes, ok: false, erro: String(e) });
    }
  }
}
return resultado;`;

test('todas as 19 views renderizam em quatro competências com dados fictícios', () => {
  assert.doesNotMatch(app, /^import /m, 'Imports do browser precisam ser isolados no teste');
  const runner = new Function(
    'window','navigator','localStorage','document','createClient','titles',
    core + '\n' + aliases + '\n' + notas + '\n' + app + '\n' + script
  );
  const result = runner(
    { addEventListener() {}, scrollTo() {}, crypto: {} },
    { onLine: true, platform: 'QA' },
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    { getElementById() { return null; }, addEventListener() {},
      documentElement: { getAttribute() { return 'light'; } } },
    () => ({auth: {onAuthStateChange() {}}}),
    titles
  );
  assert.equal(result.length, 76);
  assert.deepEqual(result.filter(x => !x.ok), []);
});
