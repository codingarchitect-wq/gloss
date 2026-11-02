<a href="https://usegloss.io">
  <img alt="Gloss" src="./public/og.png">
  <h1 align="center">Gloss</h1>
</a>

<p align="center">
  An open source AI reader for articles and PDFs. Select any line, ask a question, and get a cited answer in the margin.
</p>

## Tech stack

- DeepSeek V4.1 Flash for answers, Qwen for scanned PDF pages, FLUX for covers and MAI-Voice for reading aloud
- [OpenRouter](https://openrouter.ai) for all model inference
- [Exa](https://exa.ai) for web search
- [LiteParse](https://github.com/run-llama/liteparse) for in-browser PDF parsing
- [Clerk](https://clerk.com) for optional auth and [Neon](https://neon.tech) for syncing your library
- Next.js app router with Tailwind

## Cloning & running

1. Clone the repo: `git clone https://github.com/Nutlope/gloss`
2. Create a `.env.local` file (use `.env.example` for reference) and add your API keys:
   - **[OpenRouter API key](https://openrouter.ai/settings/keys)**: `OPENROUTER_API_KEY=`
   - **Database URL** from [Neon](https://neon.tech): `DATABASE_URL=`
   - **Clerk keys** from [Clerk](https://clerk.com): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=` and `CLERK_SECRET_KEY=`
   - **Exa API key** (optional, for web search): `EXA_API_KEY=`
3. Run `npm install` and `npm run db:migrate` to install dependencies and create the tables
4. Run `npm run dev` and open http://localhost:3100

## Running it with Docker

To keep Gloss running on your own machine, with your library saved in a local Postgres:

1. Optionally, create `.env.local` with `OPENROUTER_API_KEY=` (and `EXA_API_KEY=`) for answers, topics and covers. Without one, you can still add your key in the app.
2. Run `docker compose up -d --build` and open http://localhost:3100

This builds Gloss for one reader with no sign-in (`NEXT_PUBLIC_GLOSS_LOCAL_USER=1`), so both ports are bound to `127.0.0.1` only. Everything you save is kept in the `gloss-db` volume, which survives restarts and rebuilds (`docker compose down -v` deletes it). The database is also reachable from the Mac at `postgres://gloss:gloss@localhost:5442/gloss`.

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
- [ ] Move the shared-key rate limit to a store like Upstash so it holds across instances
