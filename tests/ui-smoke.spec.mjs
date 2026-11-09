import { test, expect } from '@playwright/test';

const fakeSupabase = String.raw\`
class FakeQuery {
  constructor(table) { this.table = table; }
  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() {
    const data = this.table === 'membros'
      ? { grupo_id: 'grupo-qa-ficticio', nome: 'Pessoa QA' }
      : this.table === 'config'
      ? { grupo_id: 'grupo-qa-ficticio', saldo_conferido: 5000,
          saldo_conferido_em: '2026-11-01', reserva_atual: 0, aporte_mensal: 0 }
      : null;
    return Promise.resolve({ data, error: null });
  }
  then(resolve, reject) {
    // Apenas leituras artificiais; nunca consulta o Supabase real.
    return Promise.resolve({ data: [], error: null }).then(resolve, reject);
  }
  insert() { throw new Error('QA: escrita no Supabase bloqueada'); }
  update() { throw new Error('QA: escrita no Supabase bloqueada'); }
  delete() { throw new Error('QA: escrita no Supabase bloqueada'); }
  upsert() { throw new Error('QA: escrita no Supabase bloqueada'); }
}
export function createClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'usuario-ficticio-qa' } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    from: name => new FakeQuery(name),
    channel: () => ({
      on() { return this; },
      subscribe() { return this; }
    }),
    removeChannel: async () => {}
  };
}\`;

test.beforeEach(async ({ page }) => {
  // Bloqueia qualquer comunicação com o backend financeiro real.
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.route('**/esm.sh/**', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' },
    body: fakeSupabase
  }));
});

test('interface inicializa e navega pelas 19 telas em modo demonstrativo isolado', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#main')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.rodape-v')).toHaveText('v113.0');

  await page.evaluate(() => window.toggleDemo());
  await expect(page.locator('.demo-banner')).toContainText('Dados totalmente fictícios');

  const telas = [
    ['painel', 'Painel'], ['extrato', 'Extrato'], ['lanc', 'Lançamentos'],
    ['fatura', 'Fatura'], ['parc', 'Parcelamentos'], ['assin', 'Assinaturas'],
    ['terc', 'Terceiros'], ['dash', 'Dashboard'], ['proj', 'Projeção'],
    ['compra', 'Nova compra'], ['cal', 'Calendário'], ['amort', 'Amortização'],
    ['casa', 'Projeções Casa'], ['cad', 'Cadastros'], ['metas', 'Metas'],
    ['backup', 'Cópias'], ['log', 'Atividade'], ['integridade', 'Integridade dos dados'],
    ['notas', 'Bloco de notas']
  ];
  for (const [id, titulo] of telas) {
    await page.evaluate(id => window.go(id), id);
    await expect(page.locator('#main .phead h1'), 'Falha na aba '+id)
      .toContainText(titulo);
    await expect(page.locator('.demo-banner')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('painel, faturas e extrato mantêm controles e projeções visíveis', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#main')).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => window.toggleDemo());

  await page.evaluate(() => window.go('painel'));
  await expect(page.locator('#main')).toContainText('R$');
  await page.screenshot({ path: 'test-results/dueto-painel-demo.png', fullPage: true });

  await page.evaluate(() => window.go('fatura'));
  await expect(page.locator('#main')).toContainText('BB Demo');
  await page.screenshot({ path: 'test-results/dueto-fatura-demo.png', fullPage: true });

  await page.evaluate(() => window.go('extrato'));
  await expect(page.locator('#main')).toContainText('Extrato');
  await page.screenshot({ path: 'test-results/dueto-extrato-demo.png', fullPage: true });

  await page.evaluate(() => window.go('integridade'));
  await expect(page.locator('#main')).toContainText('Diagnóstico');
});
