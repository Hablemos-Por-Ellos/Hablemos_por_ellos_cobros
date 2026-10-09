// ESCRITURA LOCAL: screenshots and browser-only fictional mutations; never a real admin session.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

assert.ok(process.argv.includes('--demo-ui=yes'), 'EXPLICIT_DEMO_UI_OPT_IN_REQUIRED');
assert.ok(process.env.HPE_PLAYWRIGHT_MODULE && process.env.HPE_UI_ARTIFACT_DIR, 'EXISTING_RUNTIME_AND_PRIVATE_OUTPUT_REQUIRED');
const { chromium } = createRequire(import.meta.url)(process.env.HPE_PLAYWRIGHT_MODULE);
const output = path.resolve(process.env.HPE_UI_ARTIFACT_DIR);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let checks = 0;
let screenshots = 0;
let blockedRequests = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'mobile', width: 390, height: 844 }, { name: 'small-mobile', width: 320, height: 740 }]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && (url.hostname !== '127.0.0.1' || url.port !== '3000')) {
        blockedRequests++; return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    for (const [name, route] of [['subscriptions', '/admin/suscripciones'], ['donors', '/admin/donantes'], ['payments', '/admin/pagos'], ['detail', '/admin/donantes/donor-retry?subscription=sub-retry']]) {
      await page.goto(`http://127.0.0.1:3000${route}`, { waitUntil: 'networkidle' });
      check(await page.locator('body').innerText().then((text) => /ficticios|Vista local/i.test(text)), `${viewport.name}/${name}: explicit fictional banner`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${viewport.name}/${name}: no horizontal overflow`);
      check(await page.locator('img').evaluateAll((images) => images.filter((image) => image.getClientRects().length > 0)
        .every((image) => image.complete && image.naturalWidth > 0)), `${viewport.name}/${name}: visible bitmap assets loaded`);
      await page.screenshot({ path: path.join(output, `admin-v040-${viewport.name}-${name}.png`), fullPage: true });
      screenshots++;
    }
    await page.goto('http://127.0.0.1:3000/admin/suscripciones', { waitUntil: 'networkidle' });
    await page.getByRole('combobox', { name: 'Tipo de aporte' }).selectOption('one_time');
    await page.waitForFunction(() => document.querySelector('main')?.innerText.includes('Sofia Demo'));
    check((await page.locator('main').innerText()).includes('Sofia Demo'), `${viewport.name}: unique filter`);
    await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
    await page.getByRole('textbox').first().fill('nonexistent-fixture-000');
    await page.waitForFunction(() => /0 registros/.test(document.querySelector('main')?.innerText ?? ''));
    check(/0 registros/.test(await page.locator('main').innerText()), `${viewport.name}: empty search`);
    await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
    if (viewport.name === 'desktop') {
      await page.getByRole('button', { name: /Abrir resumen de Lucia Rivas Demo/ }).click();
      await page.screenshot({ path: path.join(output, 'admin-v040-desktop-side-detail.png'), fullPage: true });
      screenshots++;
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'desktop side-detail fits');
    }
    await page.goto('http://127.0.0.1:3000/admin/donantes/donor-retry?subscription=sub-retry', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Cancelar reintento', exact: true }).click();
    const dialog = page.getByRole('dialog');
    check(await dialog.getByRole('button', { name: 'Confirmar cambio' }).isDisabled(), `${viewport.name}: confirmation requires reason`);
    await dialog.getByLabel('Motivo', { exact: true }).fill('Solicitud ficticia del laboratorio');
    check(await dialog.getByRole('heading', { name: 'Antes', exact: true }).isVisible(), `${viewport.name}: before confirmation visible`);
    check(await dialog.getByRole('heading', { name: 'Después', exact: true }).isVisible(), `${viewport.name}: after confirmation visible`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${viewport.name}: confirmation fits`);
    await page.screenshot({ path: path.join(output, `admin-v040-${viewport.name}-confirmation.png`), fullPage: true });
    screenshots++;
    await dialog.getByRole('button', { name: 'Confirmar cambio' }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(await page.getByRole('button', { name: 'Cancelar reintento', exact: true }).count() === 0, `${viewport.name}: fictional retry cancellation applied`);
    check((await page.locator('main').innerText()).includes('demo-retry-original'), `${viewport.name}: original attempt history retained`);
    const donationPage = await page.goto('http://127.0.0.1:3000/donar', { waitUntil: 'networkidle' });
    check(donationPage.status() === 200, `${viewport.name}: public donation page opens locally`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${viewport.name}: donation page fits`);
    const response = await page.request.post('http://127.0.0.1:3000/api/donations', { data: {} });
    check(response.status() === 503, `${viewport.name}: financial API blocked`);
    await context.close();
  }
  check(blockedRequests === 0, 'No external requests or provider/database traffic');
  console.log(JSON.stringify({ version: '0.4.0', checks, screenshots, blockedRequests, data: 'fictitious', output }));
} finally { await browser.close(); }
