# meera-linkedin-bot

Telegram bot for Meera Pillai (Skinstinct). She drops raw notes into Telegram. The bot scores each note, and for strong ones finds a current news angle and sends back a LinkedIn draft in her voice. She stays the author: nothing is posted automatically.

## Pipeline

1. **Evaluate and score** (Gemini Flash): 1-10 for LinkedIn relevancy, borderline rounds down.
2. **Gatekeeper**: below 7, she gets feedback (what works, what is missing, one question) and the run stops.
3. **Refine and research**: one-sentence thesis, one Google News RSS query (one retry with a reworded query).
4. **Synthesize and draft** (Claude if `ANTHROPIC_API_KEY` is set, otherwise Gemini): 100-200 words, hook, insight, data, takeaway, question. Any news used is listed with source, date and link plus a check-before-publishing flag.

Replying `APPROVE` or `REJECT` to a draft updates its status in Supabase. Notes and rejected drafts are kept.

## Stack

| Piece | Role |
|---|---|
| Telegram Bot API | Input and output |
| Vercel (Node, bom1) | Hosts `api/webhook` and `api/health` |
| Gemini | Scoring, feedback, research planning |
| Claude (optional) | Drafting |
| Google News RSS | News angle, no key needed |
| Supabase | `notes`, `drafts`, `voice_skill` tables (RLS on, server access only) |

## Setup

1. Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored.
2. Add the same variables in Vercel > Settings > Environment Variables.
3. Deploy, then register the webhook (replace the placeholders):

```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url=https://<project>.vercel.app/api/webhook \
  -d secret_token=<TELEGRAM_WEBHOOK_SECRET> \
  -d allowed_updates='["message","channel_post"]'
```

4. Open `https://<project>.vercel.app/api/health` to confirm every service answers.

## Development

```
npm run check   # syntax check
npm test        # offline test with all services mocked
```

## Security

- No keys in the repo. A gitleaks scan runs on every push (`.github/workflows/secret-scan.yml`).
- The webhook rejects any request without Telegram's secret token header and ignores chats other than `TELEGRAM_CHAT_ID`.
- Supabase tables have row level security with no public policies; only the server's secret key can read or write.

## Claude Code skills

- `.claude/skills/meera-pipeline` describes the rules of this repo.
- For Supabase work, also install the official skills: `npx skills add supabase/agent-skills`.
