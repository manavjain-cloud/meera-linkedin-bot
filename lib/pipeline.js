// The 4-stage pipeline from the project brief:
// Stage 1 Evaluate & Score -> Stage 2 Gatekeeper -> Stage 3 Refine & Research -> Stage 4 Synthesize & Draft
// send_telegram_message is called exactly once per run, at the stage that ends the run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  gemini, claude, hasClaude, db, googleRssSearch, sendTelegramMessage, cleanText,
} from './services.js';

export const PASS_SCORE = Number(process.env.PASS_SCORE || 7);

// ---------- Voice Skill ----------

async function loadVoiceSkill() {
  try {
    const rows = await db('voice_skill?is_active=eq.true&order=created_at.desc&limit=1&select=content');
    if (rows?.[0]?.content) return rows[0].content;
  } catch (e) {
    console.warn('voice_skill table unavailable, falling back to file:', e.message);
  }
  return readFileSync(join(process.cwd(), 'voice-skill.txt'), 'utf8');
}

// ---------- Stage 1: Evaluate & Score ----------

const SCORING_PROMPT = (note) => `You are the gatekeeper for Meera Pillai, founder of Skinstinct (a D2C skincare brand in Mumbai, ex-pharma formulation background). Score the transcribed note below 1-10 for LinkedIn Relevancy.

Rubric:
- 1-3: Personal or off-topic chatter, logistics, reminders, incomplete thoughts, nothing professional.
- 4-6: A professional topic is present, but the point is vague, generic or already overdone (e.g. "hard work pays off", "communication is key") with no personal angle or specific example.
- 7-10: A clear, specific professional insight, opinion or update that a reader could not get from a generic listicle. It must include at least one concrete detail (an example, number, experience or stance) that makes it Meera's.

If the score is borderline between two bands, round DOWN and explain why in one sentence. False positives waste Meera's time more than an extra clarifying round.

Return JSON only: {"score": <integer 1-10>, "band": "1-3|4-6|7-10", "justification": "<2-3 sentences citing the concrete detail or its absence>", "borderline_note": "<one sentence or empty string>"}

<transcribed_input>
${note}
</transcribed_input>`;

export async function scoreNote(note) {
  const { text } = await gemini(SCORING_PROMPT(note), { json: true, temperature: 0.1 });
  const score = Math.max(1, Math.min(10, Math.round(Number(text.score))));
  if (!Number.isFinite(score)) throw new Error('Scoring returned no numeric score');
  return { ...text, score };
}

// ---------- Stage 2: Gatekeeper feedback ----------

const FEEDBACK_PROMPT = (note, s) => `Meera sent this note and it scored ${s.score}/10 for LinkedIn relevancy (${s.justification}).
Write a short, specific, encouraging Telegram reply to her with exactly three parts:
1) What's promising about the idea (one sentence, specific to her note).
2) Exactly what's missing (a concrete example, a number, a stance, or a "why now").
3) One prompting question to help her elaborate.
Plain text, under 90 words, no headings, no emoji, no em dashes, no curly quotes. Do not mention the score.

<transcribed_input>
${note}
</transcribed_input>`;

const scoreHeader = (s) =>
  `SCORE: ${s.score}/10 (pass mark ${PASS_SCORE})\nWhy: ${[s.justification, s.borderline_note].filter(Boolean).join(' ')}`;

export async function writeFeedback(note, s) {
  const { text } = await gemini(FEEDBACK_PROMPT(note, s), { temperature: 0.5 });
  return cleanText(`${scoreHeader(s)}\n\nNo draft this time.\n\n${text}`);
}

// ---------- Stage 3: Refine & Research ----------

const RESEARCH_PROMPT = (note) => `Distill this note from Meera Pillai (skincare founder, Mumbai) into a one-sentence core thesis, then write one precise, SEO-friendly Google News search query (3-7 words, no quotes or operators) targeting recent news or data that would substantiate the thesis. Also give one alternative query with different wording, in case the first returns nothing.
Return JSON only: {"thesis": "...", "query": "...", "alt_query": "..."}

<transcribed_input>
${note}
</transcribed_input>`;

export async function research(note) {
  const { text: plan } = await gemini(RESEARCH_PROMPT(note), { json: true, temperature: 0.2 });
  let query = plan.query;
  let news = await googleRssSearch(query);
  if (!news.length && plan.alt_query) {
    query = plan.alt_query; // reformulate once and retry, per the brief
    news = await googleRssSearch(query);
  }
  return { thesis: plan.thesis, query, news };
}

// ---------- Stage 4: Synthesize & Draft ----------

const DRAFT_SYSTEM = (voice) => `You write LinkedIn posts as Meera Pillai. Follow this voice profile exactly:

${voice}

Hard rules:
- Structure: Hook (1-2 lines, specific, not generic) -> Meera's core insight in her own words and tone -> supporting data or news, cited naturally -> one actionable takeaway -> one open-ended question inviting comments.
- Preserve Meera's original phrasing and specific details wherever possible. Refine grammar and flow; do not replace her language with generic corporate phrasing.
- 100-200 words. Short paragraphs separated by blank lines. No more than 2 hashtags. No emoji unless present in her note.
- Never use em dashes or en dashes. Use hyphens. Use straight quotes only, never curly quotes.
- Never invent statistics, studies, quotes, dates, stories or sources. Only use numbers and facts that appear in her note or in the news item you use.
- The voice profile quotes her past posts as STYLE examples only. Never reuse their facts, numbers, dates or anecdotes (for example 2021, 7 months, 23%, pH 3.2) unless they also appear in this note.
- Conversational, authoritative, authentic. Not robotic, not salesy.`;

const DRAFT_PROMPT = (note, thesis, news) => `Core thesis: ${thesis}

Recent news items (may be empty):
${news.length ? news.map((n, i) => `[${i}] ${n.title} | ${n.source} | ${n.date}\n${n.summary}`).join('\n\n') : '(none found)'}

If one news item is genuinely relevant, use it to make the post timely. If none fits naturally, ignore them all and do not mention news.

Return JSON only: {"post": "<the LinkedIn post, ready to copy-paste>", "news_index": <index of the item you used, or null>}

<transcribed_input>
${note}
</transcribed_input>`;

const countWords = (s) => s.split(/\s+/).filter(Boolean).length;

// Every number in the draft must come from the note or the news item it uses.
const numbersIn = (s) => (String(s || '').match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.'));
export function inventedNumbers(post, note, usedNews) {
  const allowed = new Set([
    ...numbersIn(note),
    ...numbersIn(usedNews ? `${usedNews.title} ${usedNews.summary}` : ''),
  ]);
  const body = post.replace(/#\w+/g, ''); // ignore hashtags
  return [...new Set(numbersIn(body).filter((n) => !allowed.has(n)))];
}

export async function draftPost(note, thesis, news) {
  const voice = await loadVoiceSkill();
  const system = DRAFT_SYSTEM(voice);
  const prompt = DRAFT_PROMPT(note, thesis, news);

  const run = async (p) => {
    if (hasClaude()) {
      const { text, model } = await claude(p, { system });
      return { out: JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')), model };
    }
    const writer = process.env.GEMINI_WRITER_MODEL || 'gemini-pro-latest';
    const { text, model } = await gemini(p, { json: true, system, temperature: 0.7, model: writer });
    return { out: text, model };
  };

  const check = (out) => {
    const post = cleanText(String(out.post || ''));
    const idx = Number.isInteger(out.news_index) ? out.news_index : null;
    const usedNews = idx !== null && news[idx] ? news[idx] : null;
    const words = countWords(post);
    const invented = inventedNumbers(post, note, usedNews);
    const problems = [];
    if (words < 100 || words > 200) problems.push(`It was ${words} words; land between 120 and 180.`);
    if (invented.length) problems.push(`It contains numbers that are not in her note or the news item: ${invented.join(', ')}. Remove them and any sentence built on them. Do not replace them with other invented facts.`);
    return { post, usedNews, invented, problems };
  };

  let { out, model } = await run(prompt);
  let r = check(out);
  if (r.problems.length) {
    ({ out, model } = await run(`${prompt}\n\nRewrite your previous draft and fix these problems:\n- ${r.problems.join('\n- ')}\n\nPrevious draft:\n${r.post}`));
    r = check(out);
  }
  return { post: r.post, usedNews: r.usedNews, invented: r.invented, model };
}

export function formatDraftMessage({ post, score, usedNews, news, query, invented }) {
  const lines = [scoreHeader(score), '', '========== DRAFT ==========', post, '===========================', '', 'SOURCES'];
  if (usedNews) {
    lines.push(
      `Used in post: ${usedNews.title}`,
      `From: ${usedNews.source || 'Google News'} | ${usedNews.date}`,
      `Link: ${usedNews.link}`,
      'CHECK THIS BEFORE PUBLISHING - you are the author of this claim'
    );
  } else if (news.length) {
    lines.push('No news item was used in the post (none fitted naturally).');
  } else {
    lines.push('No supporting news data was found. No statistics were added.');
  }
  const others = news.filter((n) => n !== usedNews).slice(0, 3);
  if (others.length) {
    lines.push('', `Also found for "${query}":`);
    others.forEach((n, i) => lines.push(`${i + 1}. ${n.title} | ${n.source} | ${n.date}`, `   ${n.link}`));
  }
  lines.push('', 'Other facts: everything else comes from your note.');
  if (invented?.length) lines.push(`WARNING: these numbers are not in your note: ${invented.join(', ')}. Check or remove them.`);
  lines.push('', 'Reply APPROVE or REJECT to this message.');
  return cleanText(lines.join('\n'));
}

// ---------- Orchestrator ----------

export async function runPipeline({ note, noteId, chatId, messageId }) {
  // Stage 1
  const s = await scoreNote(note);
  console.log(`[stage1] score=${s.score} band=${s.band} :: ${s.justification} ${s.borderline_note || ''}`);
  await db(`notes?id=eq.${noteId}`, {
    method: 'PATCH',
    body: { score: s.score, score_reason: [s.justification, s.borderline_note].filter(Boolean).join(' ') },
  });

  // Stage 2
  if (s.score < PASS_SCORE) {
    const feedback = await writeFeedback(note, s);
    await sendTelegramMessage(feedback, { chatId, replyTo: messageId });
    await db(`notes?id=eq.${noteId}`, { method: 'PATCH', body: { status: 'rejected', feedback } });
    return { stage: 2, score: s.score };
  }

  // Stage 3
  const r = await research(note);
  console.log(`[stage3] thesis="${r.thesis}" query="${r.query}" results=${r.news.length}`);

  // Stage 4
  const d = await draftPost(note, r.thesis, r.news);
  const message = formatDraftMessage({
    post: d.post, score: s, usedNews: d.usedNews, news: r.news, query: r.query, invented: d.invented,
  });
  const sent = await sendTelegramMessage(message, { chatId, replyTo: messageId });

  await db('drafts', {
    method: 'POST',
    prefer: 'return=minimal',
    body: {
      note_id: noteId,
      thesis: r.thesis,
      search_query: r.query,
      news: { results: r.news, used: d.usedNews },
      model: d.model,
      content: d.post,
      status: 'pending',
      telegram_message_id: sent.message_id,
    },
  });
  await db(`notes?id=eq.${noteId}`, { method: 'PATCH', body: { status: 'drafted' } });
  return { stage: 4, score: s.score };
}
