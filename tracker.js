const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_URL = 'https://www.threads.com/@jeju_harry';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const CSV_PATH = path.join(__dirname, 'data', 'followers.csv');
const MAX_ATTEMPTS = 3;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// GitHub Actions 러너는 UTC로 동작하므로 KST 기준 날짜를 직접 계산
function kstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function extractFollowers(html) {
  // 1순위: 임베디드 JSON
  const json = html.match(/"follower_count"\s*:\s*(\d+)/);
  if (json) return Number(json[1]);

  // 2순위: meta description ("1,234 followers")
  const meta = html.match(/([\d,.]+)\s*(?:followers|팔로워)/i);
  if (meta) return Number(meta[1].replace(/[,.]/g, ''));

  return null;
}

async function scrapeOnce() {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'ko-KR',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // networkidle 대신 domcontentloaded 사용 (Threads는 백그라운드 요청이
    // 계속 돌아 networkidle이 영영 안 잡히는 경우가 있음)
    const response = await page.goto(PROFILE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    if (!response || !response.ok()) {
      throw new Error(`HTTP ${response ? response.status() : 'no response'}`);
    }

    await page.waitForTimeout(5000);

    const html = await page.content();
    const followers = extractFollowers(html);

    if (followers === null) {
      const loginWall = /log in|로그인/i.test(html) && html.length < 200000;
      throw new Error(
        loginWall
          ? '로그인 페이지가 반환됨 (봇 차단 의심)'
          : `팔로워 수를 찾지 못함 (HTML ${html.length}자)`
      );
    }

    return followers;
  } finally {
    await browser.close();
  }
}

// 같은 날짜 행이 이미 있으면 교체(수동 재실행 대비), 없으면 추가
function saveToCsv(date, followers) {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });

  const header = 'date,followers,change';
  let rows = [];

  if (fs.existsSync(CSV_PATH)) {
    rows = fs
      .readFileSync(CSV_PATH, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== header && !l.startsWith(`${date},`));
  }

  let change = '';
  if (rows.length > 0) {
    const prev = Number(rows[rows.length - 1].split(',')[1]);
    if (Number.isFinite(prev)) {
      const diff = followers - prev;
      change = diff > 0 ? `+${diff}` : String(diff);
    }
  }

  rows.push(`${date},${followers},${change}`);
  fs.writeFileSync(CSV_PATH, [header, ...rows].join('\n') + '\n');

  return change;
}

(async () => {
  let followers = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      followers = await scrapeOnce();
      console.log(`[시도 ${attempt}] 성공 — 팔로워: ${followers}`);
      break;
    } catch (err) {
      lastError = err;
      console.warn(`[시도 ${attempt}/${MAX_ATTEMPTS}] 실패: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const backoff = attempt * 15000;
        console.log(`${backoff / 1000}초 후 재시도...`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  if (followers === null) {
    console.error('모든 시도 실패');
    throw lastError;
  }

  const date = kstDate();
  const change = saveToCsv(date, followers);
  console.log(`CSV 기록: ${date}, ${followers}${change ? ` (${change})` : ''}`);

  if (!WEBHOOK_URL) {
    console.warn('WEBHOOK_URL 미설정 — 스프레드시트 전송 건너뜀');
    return;
  }

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ followers, date }),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`전송 실패: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

  console.log('전송 완료:', body.slice(0, 200));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
