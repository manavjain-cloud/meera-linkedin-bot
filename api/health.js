// Health check: reports which settings are present and whether each service answers.
// Never returns secret values.
import { gemini, db } from '../lib/services.js';

export const config = { maxDuration: 30 };

const KEYS = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'GEMINI_API_KEY',
  'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY',
];

export default async function handler(req, res) {
  const env = Object.fromEntries(KEYS.map((k) => [k, Boolean(process.env[k])]));
  const checks = {};

  try {
    const { text, model } = await gemini('Reply with the single word OK.', { temperature: 0 });
    checks.gemini = { ok: /ok/i.test(text), model };
  } catch (e) {
    checks.gemini = { ok: false, error: e.message.slice(0, 200) };
  }

  try {
    const rows = await db('voice_skill?select=id&limit=1');
    checks.supabase = { ok: true, voiceSkillRows: rows.length };
  } catch (e) {
    checks.supabase = { ok: false, error: e.message.replace(/sb_secret_\S+/g, '***').slice(0, 200) };
  }

  res.status(200).json({ env, checks });
}
