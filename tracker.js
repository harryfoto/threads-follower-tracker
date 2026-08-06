const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USERNAME = 'jeju_harry';
const PROFILE_URL = `https://www.threads.com/@${USERNAME}`;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
// 정확한 값을 못 구했을 때 반올림값이라도 기록하려면 ALLOW_APPROX=1
const ALLOW_APPROX = process.env.ALLOW_APPROX === '1';
const CSV_PATH = path.join(__dirname, 'data', 'followers.csv');
const MAX_ATTEMPTS = 3;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function kstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- 파싱 */

// 구분자만 있는 정확한 숫자인지("19,342") 반올림 표기인지("1.9만") 구분한다.
function parseCount(text) {
  if (!text) return null;
  const match = String(text).match(/([\d][\d.,\s]*)\s*([KMkm만천억]?)/);
  if (!match) return null;

  const unit = match[2].toLowerCase();
  const multiplier = { k: 1e3, m: 1e6, 만: 1e4, 천: 1e3, 억: 1e8 }[unit] ?? 1;
  const raw = match[1].replace(/\s/g, '');

  const base = multiplier === 1
    ? Number(raw.replace(/[.,]/g, ''))
    : Number(raw.replace(',', '.'));

  if (!Number.isFinite(base) || base <= 0) return null;
  return { value: Math.round(base * multiplier), approximate: multiplier !== 1 };
}

// 페이지에는 추천 계정 등 남의 JSON도 섞여 들어온다.
// 값 주변에서 가장 가까운 username을 보고 소유자를 판별한다.
function collectCandidates(html) {
  const found = [];
  const re = /"follower_count"\s*:\s*(\d+)/g;
  let match;

  while ((match = re.exec(html)) !== null) {
    const from = Math.max(0, match.index - 2000);
    const context = html.slice(from, match.index + 2000);

    let owner = null;
    let best = Infinity;
    for (const m of context.matchAll(/"username"\s*:\s*"([^"]{1,40})"/g)) {
      const distance = Math.abs(from + m.index - match.index);
      if (distance < best) {
        best = distance;
        owner = m[1];
      }
    }

    found.push({ value: Number(match[1]), owner });
  }

  return found;
}

function pickFromJson(candidates) {
  const mine = candidates.filter((c) => c.owner === USERNAME);
  if (mine.length) {
    return { value: mine[0].value, source: `임베디드 JSON (${USERNAME} 확인)`, approximate: false };
  }

  const unique = [...new Set(candidates.map((c) => c.value))];
  if (unique.length === 1 && candidates.length > 0) {
    return { value: unique[0], source: '임베디드 JSON (후보 1종)', approximate: false };
  }

  return null;
}

/* ------------------------------------------------------------- 스크래핑 */

// 화면 표기는 한국어("팔로워 1.9만명")와 영어("19K followers")의 어순이 반대다.
const VISIBLE_RE = [
  /(?:팔로워|followers)\s*([\d][\d.,]*\s*[KM만천억]?)\s*명?/i,
  /([\d][\d.,]*\s*[KM만천억]?)\s*(?:팔로워|followers)/i,
];

function readVisibleText(text) {
  for (const re of VISIBLE_RE) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

// 구분자가 들어간 정확한 숫자(19,956)만 골라낸다. 반올림 표기는 걸리지 않는다.
function exactNumbersIn(text) {
  return [...String(text).matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)].map((m) => m[0]);
}

// 툴팁의 마크업 구조를 모르므로, 마우스를 올리기 전후의 화면 텍스트를 비교해
// "새로 나타난 정확한 숫자"를 찾는다. 구조가 바뀌어도 잘 견딘다.
async function readExactByHover(page) {
  const target = page
    .getByText(/(?:팔로워|followers)\s*[\d][\d.,]*\s*[KM만천억]?\s*명?|[\d][\d.,]*\s*[KM만천억]?\s*(?:팔로워|followers)/i)
    .last();

  if (!(await target.count().catch(() => 0))) {
    console.log('  (팔로워 표기 요소를 찾지 못해 hover 생략)');
    return null;
  }

  const before = await page.evaluate(() => document.body.innerText || '');

  try {
    await target.scrollIntoViewIfNeeded({ timeout: 5000 });
    await target.hover({ timeout: 5000, force: true });
    await page.waitForTimeout(1800);
  } catch (err) {
    console.log(`  (hover 실패: ${err.message.split('\n')[0]})`);
    return null;
  }

  const seen = new Set(exactNumbersIn(before));

  const newNumber = async () => {
    const after = await page.evaluate(() => document.body.innerText || '');
    return exactNumbersIn(after).filter((n) => !seen.has(n))[0] ?? null;
  };

  const first = await newNumber();
  if (first) return first;

  // headless에서는 요소 hover만으로 툴팁이 안 뜨는 경우가 있다.
  // 실제 마우스를 여러 단계로 움직여 한 번 더 시도한다.
  try {
    const box = await target.boundingBox();
    if (box) {
      await page.mouse.move(box.x - 60, box.y - 60);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
      await page.waitForTimeout(2000);
      const second = await newNumber();
      if (second) return second;
    }
  } catch {
    // 좌표 이동이 실패해도 아래 속성 검사로 넘어간다
  }

  // 속성에 들어 있는 경우도 함께 확인한다
  return page.evaluate(() => {
    const pattern = /\b\d{1,3}(?:,\d{3})+\b/;
    for (const el of document.querySelectorAll('[role="tooltip"], [title], [aria-label]')) {
      const text = `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`;
      const m = text.match(pattern);
      if (m) return m[0];
    }
    return null;
  });
}

async function scrapeOnce() {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'ko-KR',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });

    const page = await context.newPage();

    const response = await page.goto(PROFILE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    if (!response || !response.ok()) {
      throw new Error(`HTTP ${response ? response.status() : 'no response'}`);
    }

    await page.waitForTimeout(5000);

    const html = await page.content();
    const candidates = collectCandidates(html);

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const visible = readVisibleText(bodyText);

    const tooltip = await readExactByHover(page);

    console.log(`  HTML ${html.length}자 / JSON 후보 ${candidates.length}개`);
    candidates.slice(0, 6).forEach((c, i) => {
      console.log(`    ${i + 1}. ${c.value} (소유자 추정: ${c.owner ?? '불명'})`);
    });
    console.log(`  화면 표시값: ${visible ?? '없음'}`);
    console.log(`  툴팁/속성값: ${tooltip ?? '없음'}`);

    // 1순위: 임베디드 JSON — 반올림되지 않은 원본 값
    const fromJson = pickFromJson(candidates);
    if (fromJson) return fromJson;

    // 2순위: 마우스를 올렸을 때 나오는 정확한 값
    const fromTooltip = parseCount(tooltip);
    if (fromTooltip && !fromTooltip.approximate) {
      return { value: fromTooltip.value, source: `툴팁 "${tooltip}"`, approximate: false };
    }

    // 3순위: 화면 표시값. 1만이 넘으면 반올림이라 추적용으로는 못 쓴다.
    const fromVisible = parseCount(visible);
    if (fromVisible) {
      return { value: fromVisible.value, source: `화면 표시값 "${visible}"`, approximate: fromVisible.approximate };
    }

    const loginWall = /log in|로그인/i.test(html) && html.length < 200000;
    throw new Error(loginWall ? '로그인 페이지가 반환됨 (봇 차단 의심)' : '팔로워 수를 찾지 못함');
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ 기록 */

function saveToCsv(date, followers) {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });

  const header = 'date,followers,change';
  const rows = (fs.existsSync(CSV_PATH) ? fs.readFileSync(CSV_PATH, 'utf8') : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('date,') && !l.startsWith(`${date},`));

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

/* ------------------------------------------------------------------ 실행 */

(async () => {
  let result = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[시도 ${attempt}/${MAX_ATTEMPTS}]`);
      result = await scrapeOnce();
      console.log(`  → ${result.value} (출처: ${result.source})`);
      break;
    } catch (err) {
      lastError = err;
      console.warn(`  실패: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const backoff = attempt * 15000;
        console.log(`  ${backoff / 1000}초 후 재시도...`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  if (!result) {
    console.error('모든 시도 실패');
    throw lastError;
  }

  // 반올림값은 며칠씩 그대로라 기록해봐야 추이가 안 보인다. 조용히 남기지 않는다.
  if (result.approximate && !ALLOW_APPROX) {
    throw new Error(
      `반올림된 값(${result.value})만 구했습니다. 정확한 값을 읽지 못해 기록하지 않습니다. ` +
      '위 로그의 툴팁/JSON 항목을 확인하세요. 그래도 기록하려면 ALLOW_APPROX=1 을 설정하면 됩니다.'
    );
  }

  const followers = result.value;
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
  if (!res.ok) throw new Error(`전송 실패: HTTP ${res.status} — ${body.slice(0, 200)}`);
  console.log('전송 완료:', body.slice(0, 200));
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
