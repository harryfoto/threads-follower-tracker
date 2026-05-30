const { chromium } = require('playwright');

(async () => {

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  await page.goto(
    'https://www.threads.net/@jeju_harry',
    {
      waitUntil: 'networkidle'
    }
  );

  await page.waitForTimeout(5000);

  const html = await page.content();

  console.log(
    html.includes('jeju_harry')
  );

  await browser.close();

})();
