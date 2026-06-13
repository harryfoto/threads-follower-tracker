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
    html.match(/"follower_count":(\d+)/);

  if (!match) {
    throw new Error(
      'Follower count not found'
    );
  }

  const followers =
    Number(match[1]);

  console.log(
    'Followers:',
    followers
  );

  const response =
    await fetch(
      'https://script.google.com/macros/s/AKfycbxszjhcDEekMcZo_iiof0elbeouXA38g7L-oejw4lOtJy3XLkmdNp42uX6E7RBciWWxpA/exec',      
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          followers
        })
      }
    );

  console.log(
    await response.text()
  );

  await browser.close();

})();
