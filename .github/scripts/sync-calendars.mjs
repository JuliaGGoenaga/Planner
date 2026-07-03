const GIST_ID = process.env.GIST_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;

if (!GIST_ID || !GIST_TOKEN) {
  console.error('Missing GIST_ID or GIST_TOKEN secret');
  process.exit(1);
}

const ghHeaders = {
  Authorization: `token ${GIST_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
};

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const gistRes = await fetchWithTimeout(`https://api.github.com/gists/${GIST_ID}`, { headers: ghHeaders });
  if (!gistRes.ok) throw new Error(`Failed to load gist: HTTP ${gistRes.status}`);
  const gist = await gistRes.json();
  const plannerFile = gist.files['planner.json'];
  if (!plannerFile) throw new Error('planner.json not found in gist');
  // The Gist API truncates inline file content above ~1MB; fetch raw_url for the full file.
  let content = plannerFile.content;
  if ((plannerFile.truncated || !content) && plannerFile.raw_url) {
    const rr = await fetchWithTimeout(plannerFile.raw_url, {});
    if (rr.ok) content = await rr.text();
  }
  if (!content) throw new Error('planner.json content is empty');
  let planner;
  try {
    planner = JSON.parse(content);
  } catch (e) {
    throw new Error(`planner.json is not valid JSON (len ${content.length}): ${e.message}`);
  }
  const calendars = planner.calendars || [];

  const result = { updatedAt: new Date().toISOString(), calendars: {} };

  for (const cal of calendars) {
    try {
      const r = await fetchWithTimeout(cal.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PlannerCalendarSync/1.0)',
          Accept: 'text/calendar, text/plain, */*',
        },
      });
      const text = await r.text();
      if (r.ok && text.includes('BEGIN:VCALENDAR')) {
        result.calendars[cal.id] = { ok: true, ics: text };
        console.log(`OK: ${cal.name}`);
      } else {
        result.calendars[cal.id] = { ok: false, error: `HTTP ${r.status}` };
        console.warn(`FAIL: ${cal.name} — HTTP ${r.status}`);
      }
    } catch (e) {
      result.calendars[cal.id] = { ok: false, error: String(e.message || e) };
      console.warn(`FAIL: ${cal.name} — ${e.message || e}`);
    }
  }

  const patchRes = await fetchWithTimeout(
    `https://api.github.com/gists/${GIST_ID}`,
    {
      method: 'PATCH',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'calendar-cache.json': { content: JSON.stringify(result, null, 2) } } }),
    },
    15000
  );
  if (!patchRes.ok) throw new Error(`Failed to update gist: HTTP ${patchRes.status}`);
  console.log('Cache updated:', result.updatedAt);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
