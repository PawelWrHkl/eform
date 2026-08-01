const { chromium } = require('playwright');
const APP = 'http://localhost:8081';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(45000);
  await page.goto(`${APP}/user/auth/login?pin=admin&password=${encodeURIComponent('eforszef123')}`);
  await page.waitForURL('**/');
  await page.goto(`${APP}/orders/history/order/2898`);
  await page.waitForSelector('.order-table');

  const out = await page.evaluate(() => {
    const t = document.querySelector('.order-table');
    const ths = [...t.querySelectorAll('thead th')].slice(0, 4);
    const bodyRow = [...t.querySelectorAll('tbody > tr')].find(r =>
      !r.matches('.price-row,.sub-params-row,.sub-params-locked-row,.prod-time-row,.status-row'));
    const tds = bodyRow ? [...bodyRow.children].slice(0, 4) : [];
    const pick = (el, i) => {
      const s = getComputedStyle(el);
      return { n: i + 1, tag: el.tagName, position: s.position, left: s.left, zIndex: s.zIndex,
               bg: s.backgroundColor, borderRight: s.borderRightWidth + ' ' + s.borderRightColor };
    };
    return {
      stickyVars: {
        l1: t.style.getPropertyValue('--sticky-left-1'),
        l2: t.style.getPropertyValue('--sticky-left-2'),
        l3: t.style.getPropertyValue('--sticky-left-3')
      },
      colCount: t.querySelectorAll('thead th').length,
      head: ths.map(pick),
      body: tds.map(pick)
    };
  });
  console.log(JSON.stringify(out, null, 1));

  // Does the frozen block still track horizontal scroll?
  const cont = await page.$('.order-table-container');
  const before = await page.evaluate(() => {
    const c = document.querySelector('.order-table-container');
    const cell = document.querySelector('.order-table thead th:nth-child(1)');
    return { scrollable: c ? c.scrollWidth > c.clientWidth : null, x: cell.getBoundingClientRect().left };
  });
  await page.evaluate(() => { const c = document.querySelector('.order-table-container'); if (c) c.scrollLeft = 300; });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => document.querySelector('.order-table thead th:nth-child(1)').getBoundingClientRect().left);
  console.log('scrollable:', before.scrollable, '| col1 left before:', before.x, '→ after scrollLeft=300:', after,
              '| moved with content:', Math.abs(before.x - after) > 50 ? 'YES (unfrozen)' : 'NO (still pinned)');
  await page.screenshot({ path: '/tmp/claude-1000/-home-pawel-projects-eform-project-eform/0d51cd04-7ef6-4802-8b81-1a58e7a7bbc5/scratchpad/order_sent_scrolled.png', fullPage: false });
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
