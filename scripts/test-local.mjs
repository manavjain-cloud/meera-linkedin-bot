// Offline test of the webhook with every external service mocked. No keys needed.
process.env.TELEGRAM_BOT_TOKEN = 'test'; process.env.TELEGRAM_CHAT_ID = '42';
process.env.TELEGRAM_WEBHOOK_SECRET = 'secret'; process.env.GEMINI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SECRET_KEY = 'test';
delete process.env.ANTHROPIC_API_KEY;

const sent = []; let score = 8; let dbNotes = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const body = opts.body ? JSON.parse(opts.body) : null;
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
  if (u.includes('api.telegram.org')) { sent.push(body.text); return json({ ok: true, result: { message_id: 999 } }); }
  if (u.includes('news.google.com')) return new Response('<rss><channel><item><title>India cosmetics labelling rules tightened - Economic Times</title><link>https://example.com/a</link><pubDate>Mon, 22 Sep 2026 10:00:00 GMT</pubDate><source url="x">Economic Times</source><description>CDSCO update</description></item></channel></rss>');
  if (u.includes('sb.test')) {
    if (u.includes('voice_skill')) return json([{ content: 'Voice: plain, precise.' }]);
    if (u.endsWith('/notes') && opts.method === 'POST') { dbNotes++; return json([{ id: 'n1' }], 201); }
    if (u.includes('drafts?') && opts.method !== 'PATCH') return json([{ id: 'd1' }]);
    return new Response(null, { status: 204 });
  }
  if (u.includes('generativelanguage')) {
    const p = body.contents[0].parts[0].text; let out;
    if (p.includes('Score the transcribed note')) out = { score, band: '7-10', justification: 'Has a number.', borderline_note: '' };
    else if (p.includes('core thesis')) out = { thesis: 'Labels hide pH.', query: 'cosmetic label pH India', alt_query: 'skincare labelling India' };
    else if (p.includes('Core thesis')) out = { post: ('Word ' .repeat(130)) + '\u2014 \u201Cquoted\u201D', news_index: 0 };
    else out = null;
    return json({ candidates: [{ content: { parts: [{ text: out ? JSON.stringify(out) : 'Score 4/10.\nPromising \u2014 but vague.' }] } }] });
  }
  throw new Error('unexpected fetch ' + u);
};

const { default: handler } = await import('../api/webhook.js');
const call = async (text, headers = { 'x-telegram-bot-api-secret-token': 'secret' }, id = Math.random()) => {
  let out; const res = { status: (c) => ({ json: (d) => (out = { c, d }) }) };
  await handler({ method: 'POST', headers, body: { update_id: id, message: { message_id: 1, chat: { id: 42 }, text } } }, res);
  return out;
};
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };

let r = await call('hi', {}); assert(r.c === 401, 'rejects missing secret');
r = await call('Strong note with 23% returns data'); assert(r.d.stage === 4, 'strong note reaches stage 4');
const draft = sent.at(-1);
assert(draft.includes('NEWS SOURCE: India cosmetics labelling rules tightened'), 'draft has news source block');
assert(!/[\u2014\u2013\u201C\u201D\u2018\u2019]/.test(draft), 'no em dashes or curly quotes');
score = 5; r = await call('buy boxes tomorrow'); assert(r.d.stage === 2, 'weak note stops at stage 2');
assert(sent.at(-1).startsWith('Score 4/10.') && !sent.at(-1).includes('\u2014'), 'feedback cleaned');
r = await call('APPROVE'); assert(r.d.ok && sent.at(-1).includes('approved'), 'APPROVE updates draft');
console.log('\nAll tests passed. Telegram calls:', sent.length, 'notes saved:', dbNotes);
