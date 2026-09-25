const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = __dirname;
const out = path.join(root, 'renders');
const base = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const specs = [
  { name: '01-compact-dark', html: '01-compact-dark.html', selector: (screen) => `.tab[data-t="${screen}"]`, screens: ['overview', 'table', 'detail'] },
  { name: '02-airy-editorial', html: '02-airy-editorial.html', selector: (screen) => `[data-view="${screen === 'table' ? 'runs' : screen}"]`, screens: ['overview', 'table', 'detail'] },
  { name: '03-operator-split', html: '03-operator-split.html', selector: (screen) => `[data-view="${screen === 'table' ? 'runs' : screen}"]`, screens: ['overview', 'table', 'detail'] },
];

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: base,
    args: ['--no-sandbox', '--allow-file-access-from-files'],
  });
  const results = [];
  try {
    for (const spec of specs) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5 });
      const file = path.join(root, spec.html);
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
      await page.waitForTimeout(150);
      for (const screen of spec.screens) {
        const selector = spec.selector(screen);
        const nav = page.locator(selector).first();
        if (await nav.count() !== 1) throw new Error(`${spec.name}: missing nav ${selector}`);
        await nav.click();
        await page.waitForTimeout(100);
        const screenshot = path.join(out, `${spec.name}-${screen}.png`);
        await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
        const stat = fs.statSync(screenshot);
        results.push({ file: path.basename(screenshot), bytes: stat.size, screen, variant: spec.name });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ rendered: results.length, results }, null, 2));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
