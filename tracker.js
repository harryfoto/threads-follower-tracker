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

  const match =
    html.match(
      /"follower_count":(\d+)/
    );

  console.log(
    match ? match[1] : 'NOT_FOUND'
  );

  await browser.close();

})();
