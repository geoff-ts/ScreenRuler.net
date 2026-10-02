const { test, expect } = require('@playwright/test');

async function isolateServices(page, ad = '') {
  await page.route('https://**/*', route => {
    if (route.request().url().includes('/adsbygoogle.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: ad });
    }
    return route.abort();
  });
}
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ruler-ready', 'true');
}
test('fresh visitor can measure, calibrate, navigate and return to help', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await isolateServices(page);
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Screen Ruler', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#startupMessage')).toBeHidden();
  await expect(page.locator('#bottomAdContainer')).toBeVisible();
  const ad = await page.locator('#bottomAdSlot').boundingBox();
  expect(ad.width).toBe(320);
  expect(ad.height).toBe(50);
  await page.screenshot({ path: testInfo.outputPath('first-visit.png') });
  await page.getByRole('button', { name: 'Choose device', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#bottomAdContainer')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Choose device', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Choose device', exact: true }).click();
  await page.getByRole('button', { name: 'Manual Calibration', exact: true }).click();
  await expect(page.locator('#settingsCard')).toHaveCSS('opacity', '1');
  await page.locator('#microScaleDisplay').fill('150');
  await page.locator('#microScaleDisplay').press('Tab');
  expect(await page.evaluate(() => localStorage.getItem('calibrated_ruler_ppi'))).toBe('150');
  await page.getByRole('button', { name: 'Help & calibration' }).click();
  await page.getByRole('button', { name: 'Measure fullscreen' }).click();
  await expect(page.locator('#siteIntro')).toBeHidden();
  const before = await page.locator('#caliperHandleA').boundingBox();
  await page.locator('#caliperHandleA').focus();
  await page.keyboard.press('ArrowRight');
  const after = await page.locator('#caliperHandleA').boundingBox();
  expect(after.x).toBeGreaterThan(before.x);
  await page.getByRole('button', { name: 'Help & calibration' }).click();
  await page.getByRole('link', { name: 'How to use', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Measure with the screen in your hand');
  expect(errors).toEqual([]);
});
test('ad blockers do not hide content or reserve ad space after resize', async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await ready(page);
  await expect(page.locator('#bottomAdContainer')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 740 });
  await expect(page.locator('#bottomAdContainer')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-ruler-ready', 'true');
  await page.getByRole('button', { name: 'Measure fullscreen' }).click();
  await expect(page.getByRole('button', { name: 'Help & calibration' })).toBeVisible();
});
test('a third-party exception cannot replace a working ruler', async ({ page }) => {
  await isolateServices(page, 'setTimeout(() => { throw new Error("simulated ad provider failure"); }, 0);');
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('data-ruler-notes', /simulated ad provider failure/);
  await expect(page.locator('html')).toHaveAttribute('data-ruler-ready', 'true');
  await expect(page.locator('#siteIntro')).toBeVisible();
});
for (const file of ['app.js', 'styles.css', 'site.css']) {
  test('readable fallback when ' + file + ' is blocked', async ({ page }) => {
    await isolateServices(page);
    await page.route('**/' + file + '?*', route => route.abort());
    await page.goto('/');
    await expect(page.locator('#siteIntro')).toBeVisible();
    await expect(page.locator('#bottomAdContainer')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Measure fullscreen' })).toBeHidden();
    await page.getByRole('link', { name: 'How to use', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
}
test('disabled JavaScript leaves useful content and all guide links working', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(baseURL);
  await expect(page.locator('#siteIntro')).toBeVisible();
  await expect(page.locator('#bottomAdContainer')).toBeHidden();
  await page.getByText('Quick start', { exact: true }).click();
  await expect(page.locator('.quick-guide ol')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('no-javascript.png') });
  for (const path of ['how-to-use.html', 'guides.html', 'reference-sizes.html', 'measuring-screws-and-bolts.html', 'inch-fractions.html', 'screen-size-and-ppi.html', 'changelog.html', 'accuracy.html', 'about.html', 'privacy.html', 'contact.html']) {
    const response = await page.goto(baseURL + '/' + path);
    expect(response.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const badLinks = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter(a => !a.href || a.getAttribute('href') === '#').length);
    expect(badLinks).toBe(0);
  }
  await context.close();
});
test('slow initial app load recovers from fallback without hiding content', async ({ page }) => {
  await isolateServices(page);
  await page.route('**/app.js?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 11000));
    await route.continue();
  });
  const navigation = page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#siteIntro')).toBeVisible();
  await expect(page.locator('#bottomAdContainer')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-ruler-failed', 'true', { timeout: 14000 });
  await navigation;
  await expect(page.locator('html')).toHaveAttribute('data-ruler-ready', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-ruler-failed');
});

test('guide links, diagrams and narrow layouts work', async ({ page, request }, testInfo) => {
  const visited = new Set();
  for (const path of ['how-to-use.html', 'guides.html', 'reference-sizes.html', 'measuring-screws-and-bolts.html', 'inch-fractions.html', 'screen-size-and-ppi.html', 'changelog.html', 'accuracy.html', 'about.html', 'privacy.html', 'contact.html']) {
    await page.goto('/' + path);
    await expect(page.locator('body')).toHaveCSS('overflow-x', 'visible');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('script').count()).toBe(0);
    const links = await page.locator('a').evaluateAll(elements => elements.map(a => a.href));
    for (const link of links) {
      const url = new URL(link);
      if (url.hostname !== '127.0.0.1') continue;
      if (url.hash && url.pathname === '/' + path) await expect(page.locator(url.hash)).toHaveCount(1);
      if (visited.has(url.pathname)) continue;
      visited.add(url.pathname);
      expect((await request.get(url.href)).status()).toBe(200);
    }
    for (const img of await page.locator('img').all()) {
      expect(await img.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
      await expect(img).toHaveAttribute('alt', /.+/);
    }
    if (path === 'accuracy.html') await page.screenshot({ path: testInfo.outputPath('accuracy-guide.png'), fullPage: true });
  }
});
test('small screens and landscape keep the banner within its fixed dimensions', async ({ page }, testInfo) => {
  await isolateServices(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  await page.getByRole('button', { name: 'Measure fullscreen' }).click();
  expect((await page.locator('#bottomAdSlot').boundingBox()).width).toBe(300);
  expect((await page.locator('#bottomAdSlot').boundingBox()).height).toBe(50);
  await page.setViewportSize({ width: 844, height: 390 });
  const ad = await page.locator('#bottomAdSlot').boundingBox();
  const phoneLandscape = testInfo.project.name === 'phone';
  expect(ad.width).toBe(phoneLandscape ? 120 : 320);
  expect(ad.height).toBe(phoneLandscape ? 240 : 50);
  await page.getByRole('button', { name: 'Help & calibration' }).click();
  await expect(page.locator('#siteIntro')).toBeVisible();
  const intro = await page.locator('#siteIntro').boundingBox();
  const container = await page.locator('#bottomAdContainer').boundingBox();
  const overlaps = intro.x < container.x + container.width && intro.x + intro.width > container.x &&
    intro.y < container.y + container.height && intro.y + intro.height > container.y;
  expect(overlaps).toBe(false);
});
