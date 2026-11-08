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

Each article you add from a link also gets a saved copy of its original page, with its styles, pictures, fonts and scripts, as one HTML file made with [monolith](https://github.com/Y2Z/monolith). Open it from **Saved copy** beside **Original** in the reader. A PDF keeps the file itself, under **Saved PDF**: fetched again from its link, or sent up by your browser when you dropped it in as a file (up to 25 MB). A YouTube link becomes its transcript, from the video's captions, with each paragraph's time: click a time to play the video from there. The video itself is saved at 360p and plays above the text. A video without captions can be transcribed from its sound through OpenRouter (**Transcribe**, roughly $0.03–0.07 an hour). Copies live in the `gloss-originals` volume.

Links you want to keep rather than read, like a GitHub repo, a package, a model or a tool's home page, become cards in the library's **Links** drawer instead of books on the shelf: each with the picture the page shares itself with, its site's icon, its description and your own note, and a repo's stars and language. Paste them in **Add articles** (on **Auto**, repos and home pages go to Links on their own, and so does any page with no article on it) or straight into the drawer. The library's search finds them alongside your texts, and each topic's page lists its links under its books. A card can be read in as a text after all, and a book that was never for reading kept as a link. Agents can keep links too, with `save_links`.

This builds Gloss for one reader with no sign-in (`NEXT_PUBLIC_GLOSS_LOCAL_USER=1`), so both ports are bound to `127.0.0.1` only. Everything you save is kept in the `gloss-db` volume, which survives restarts and rebuilds (`docker compose down -v` deletes it). The database is also reachable from the Mac at `postgres://gloss:gloss@localhost:5442/gloss`.

## Future Tasks

- [ ] Ship it as a browser extension that opens the same margin on any page
- [ ] Let a gloss compare two passages you pick at once
- [ ] Move the shared-key rate limit to a store like Upstash so it holds across instances
