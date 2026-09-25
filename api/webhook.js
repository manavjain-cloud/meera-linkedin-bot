// Telegram webhook: https://<project>.vercel.app/api/webhook
import { timingSafeEqual } from 'node:crypto';
import { db, sendTelegramMessage } from '../lib/services.js';
import { runPipeline } from '../lib/pipeline.js';

export const config = { maxDuration: 60 };

function secretOk(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const HELP =
  'Send me a note: an observation from the unit, a customer DM, something you read at 11pm.\n\n' +
  'I score it. If it is strong (7+), I research a news angle and send back a LinkedIn draft in your voice. ' +
  'If not, I tell you what is missing.\n\n' +
  'Reply APPROVE or REJECT to a draft to record your decision. Nothing is ever posted for you.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'meera-linkedin-bot' });
  if (!secretOk(req)) return res.status(401).json({ ok: false });

  const update = req.body || {};
  const msg = update.message || update.channel_post;
  const text = (msg?.text || msg?.caption || '').trim();
  const chatId = msg?.chat?.id;

  // Only Meera's own chat or channel is allowed. Everything else is ignored silently.
  if (!msg || String(chatId) !== String(process.env.TELEGRAM_CHAT_ID) || !text) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    if (/^\/(start|help)\b/i.test(text)) {
      await sendTelegramMessage(HELP, { chatId });
      return res.status(200).json({ ok: true });
    }

    // Human review gate: APPROVE / REJECT
    const decision = text.match(/^(approve|approved|reject|rejected)\b/i);
    if (decision) {
      const status = decision[1].toLowerCase().startsWith('approve') ? 'approved' : 'rejected';
      const replyId = msg.reply_to_message?.message_id;
      const filter = replyId
        ? `telegram_message_id=eq.${replyId}`
        : 'status=eq.pending&order=created_at.desc&limit=1';
      const rows = await db(`drafts?${filter}&select=id`);
      if (!rows?.length) {
        await sendTelegramMessage('No matching draft found. Reply APPROVE or REJECT directly to the draft message.', { chatId });
      } else {
        await db(`drafts?id=eq.${rows[0].id}`, {
          method: 'PATCH',
          body: { status, decided_at: new Date().toISOString() },
        });
        await sendTelegramMessage(
          status === 'approved' ? 'Marked as approved. Over to you to publish it.' : 'Marked as rejected. Kept on file for review.',
          { chatId, replyTo: msg.message_id }
        );
      }
      return res.status(200).json({ ok: true });
    }

    // Save the note. update_id is unique, so Telegram retries do not run the pipeline twice.
    let note;
    try {
      [note] = await db('notes', {
        method: 'POST',
        prefer: 'return=representation',
        body: { telegram_update_id: update.update_id, chat_id: chatId, message_id: msg.message_id, text },
      });
    } catch (e) {
      if (e.code === '23505') return res.status(200).json({ ok: true, duplicate: true });
      throw e;
    }

    try {
      const result = await runPipeline({ note: text, noteId: note.id, chatId, messageId: msg.message_id });
      return res.status(200).json({ ok: true, ...result });
    } catch (e) {
      await db(`notes?id=eq.${note.id}`, { method: 'PATCH', body: { status: 'error', error: String(e.message).slice(0, 1000) } }).catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error('pipeline error:', e);
    await sendTelegramMessage('Something went wrong processing that note. It is saved, so nothing is lost. Try again in a minute.', { chatId }).catch(() => {});
    // Return 200 so Telegram does not retry into the same error.
    return res.status(200).json({ ok: false });
  }
}
