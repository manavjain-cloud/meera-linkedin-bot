---
name: meera-pipeline
description: Work on the Meera LinkedIn Telegram bot. Use when changing scoring, research, drafting, the voice skill, Supabase tables or deployment of this repo.
---

# Meera LinkedIn pipeline

Flow: Telegram note -> api/webhook.js -> lib/pipeline.js (Stage 1 score, Stage 2 gate, Stage 3 research, Stage 4 draft) -> one Telegram message per run.

Rules that must not be broken:
- Nothing is ever posted to LinkedIn automatically. Meera replies APPROVE or REJECT; drafts stay in Supabase with that status.
- send_telegram_message runs exactly once per pipeline run.
- Pass mark is PASS_SCORE (default 7). Borderline scores round down.
- google_rss_search is called once, retried once with alt_query if empty. Never invent statistics.
- Output text has no em dashes, en dashes or curly quotes. lib/services.js cleanText() enforces this.
- Every draft that uses news ends with the NEWS SOURCE / FROM / LINK / CHECK THIS block.
- Secrets live only in Vercel environment variables and a local .env (git-ignored). Never commit keys.

Checks before pushing: `npm run check && npm test`.
Voice profile: Supabase table voice_skill (active row), fallback voice-skill.txt.
