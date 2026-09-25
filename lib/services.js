// Thin wrappers around the external services. No SDKs, just fetch.
// Every secret is read from environment variables. Never hardcode keys here.

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable ${name}`);
  }
  return v;
};

// ---------- Telegram ----------

export async function sendTelegramMessage(message, { chatId, replyTo } = {}) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const body = {
    chat_id: chatId ?? env('TELEGRAM_CHAT_ID'),
    text: message.slice(0, 4096),
    link_preview_options: { is_disabled: true },
  };
  if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendMessage failed: ${data.description}`);
  return data.result;
}

// ---------- Gemini (scoring, feedback, research planning, fallback drafting) ----------

// Tried in order. On a free-tier key each model has its own daily quota, so when Flash
// runs out the Lite models keep the bot working.
const GEMINI_FALLBACK_MODELS = [
  'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash',
  'gemini-3.1-flash-lite', 'gemini-flash-lite-latest',
];

export async function gemini(prompt, { json = false, temperature = 0.4, system, model: preferred } = {}) {
  const key = env('GEMINI_API_KEY');
  const models = [preferred, process.env.GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let lastError;
  const tried = [];
  for (const model of [...new Set(models)]) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json().catch(() => ({}));
    const msg = data?.error?.message || '';
    // Model missing, or out of quota on this model: try the next one.
    if (res.status === 404 || res.status === 429 || (res.status === 400 && /not found|not supported/i.test(msg))) {
      lastError = new Error(`Gemini ${model} ${res.status}: ${msg.slice(0, 120)}`);
      tried.push(`${model}:${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${msg}`);
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
    if (!text) throw new Error('Gemini returned an empty response');
    return { text: json ? parseJson(text) : text, model };
  }
  if (lastError) lastError.message += ` (tried ${tried.join(', ')})`;
  throw lastError;
}

// ---------- Claude (optional, preferred drafter when ANTHROPIC_API_KEY is set) ----------

export async function claude(prompt, { system, temperature = 0.6 } = {}) {
  const key = env('ANTHROPIC_API_KEY');
  const model = env('ANTHROPIC_MODEL', 'claude-sonnet-4-5');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${data?.error?.message}`);
  return { text: data.content.map((c) => c.text || '').join(''), model };
}

export const hasClaude = () => Boolean(process.env.ANTHROPIC_API_KEY);

// ---------- Supabase (PostgREST over fetch, server-side secret key) ----------

function sbHeaders(extra = {}) {
  const key = env('SUPABASE_SECRET_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

export async function db(path, { method = 'GET', body, prefer } = {}) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${path} failed (${res.status}): ${data?.message || text}`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// ---------- google_rss_search (Google News RSS, no key needed) ----------

export async function googleRssSearch(query, { limit = 5 } = {}) {
  const url =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(`${query} when:60d`) +
    '&hl=en-IN&gl=IN&ceid=IN:en';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (meera-linkedin-bot)' } });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
  return items.map(([, item]) => {
    const tag = (name) => {
      const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
      return m ? decodeXml(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : '';
    };
    const source = tag('source');
    let title = tag('title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const summary = tag('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      title,
      link: tag('link'),
      source,
      date: tag('pubDate') ? new Date(tag('pubDate')).toISOString().slice(0, 10) : '',
      summary: summary.slice(0, 300),
    };
  });
}

// ---------- helpers ----------

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

// House style: no em or en dashes, no curly quotes. Hyphens and straight quotes only.
export function cleanText(s) {
  return s
    .replace(/\s*[\u2014\u2015]\s*/g, ' - ')
    .replace(/[\u2013\u2012\u2010\u2011\u2212]/g, '-')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
