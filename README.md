# Karten — German Flashcards SPA

A mobile-first, single-page German learning app with SM-2 spaced repetition.
Add a word (German *or* English — the app figures out which); it's looked up on
**dict.cc** in both directions and a flashcard is scheduled with the classic **SM-2**
algorithm. Progress survives page refreshes (stored in `localStorage`).

```
memcards/
  index.html        # the entire SPA + the dict.cc adapter (DOMParser); no build step
  worker/
    worker.js       # generic CORS proxy (not dict.cc-specific)
    wrangler.toml
```

## Architecture

- **Generic CORS proxy** (`worker/`) — a Cloudflare Worker that fetches *any* URL and
  returns it with permissive CORS headers, so the static page can read cross-origin
  sites/APIs that browsers otherwise block. It knows nothing about dict.cc.
- **Dictionary adapter lives in the app** (`index.html`). All dictionary logic —
  building dict.cc URLs, parsing the HTML with `DOMParser`, picking the best sense —
  is in a swappable `dictccBackend` object. To move to another dictionary later,
  replace that one adapter so it returns the same shape:
  `{ pairs: [{de, en}], suggestions: [word, ...] }`. The Worker doesn't change.

## Features / behavior

- **Add a word** (top-right) → the app looks it up via `deen.dict.cc` **and**
  `ende.dict.cc` (source language unknown) through the proxy.
- **Best-sense pick** — dict.cc ranks `{adj}`/verb senses above the plain noun, so the
  app scores results and prefers the pair matching the typed word exactly.
- **German always with its article** — gender markers become the definite article:
  `{m}`→*der*, `{f}`/`{pl}`→*die*, `{n}`→*das* (e.g. `Auffälligkeit {f}` → **die Auffälligkeit**).
  Non-nouns (verbs/adjectives) are stored as-is.
- **Misspelling → chooser** — if the word isn't found, dict.cc's "Ähnliche Begriffe" /
  "Similar terms" list is shown as tappable options; picking one re-runs the lookup.
- **Review** — a card shows one side (German or English, at random); SM-2 orders by due
  date and there's always a current card so **Next** never dead-ends.
- **Grading** (one-button):
  - **Next** without revealing = you knew it → SM-2 *pass* (quality 5).
  - **Tapping the card** to reveal = you didn't → SM-2 *lapse* (quality 2).
- **Persistence** — the dictionary and every card's SM-2 state (ease, interval,
  repetitions, due date) live in `localStorage["memcards.v1"]` and survive refreshes.

## Run it

### 1. Start the CORS proxy

```bash
cd worker
npx wrangler dev        # serves http://127.0.0.1:8787
```

Quick check (proxy fetches the URL you pass in `?url=`):

```bash
curl "http://127.0.0.1:8787/?url=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("https://deen.dict.cc/?s=Hund"))')" | grep -c td7nl
```

### 2. Serve the SPA

`index.html` is static:

```bash
python3 -m http.server 8080   # open http://localhost:8080 on your phone/emulator
```

The proxy URL is a constant at the top of the `<script>` in `index.html`:

```js
const PROXY_URL = "http://127.0.0.1:8787";
```

## Deploy

```bash
cd worker
npx wrangler deploy           # -> https://cors-proxy.<subdomain>.workers.dev
```

Then set `PROXY_URL` in `index.html` to that URL and host `index.html` on any static
host (Cloudflare Pages, GitHub Pages, …).

**Locking down the proxy:** by default it proxies *any* host (open proxy — fine for
personal use). To restrict it, set `ALLOWED_HOSTS` in `worker/wrangler.toml`
(comma-separated, subdomains included), e.g. `ALLOWED_HOSTS = "dict.cc"`.

## Notes / limitations

- **SM-2 intervals are in days**, so a *passed* card won't reappear the same session;
  the queue always surfaces the soonest card so review never dead-ends.
- **dict.cc's "similar terms" are alphabetical, not fuzzy.** They catch most typos
  (missing/extra/transposed letters), but an umlaut swap like *Auffeligkeit* →
  *Auffälligkeit* sorts elsewhere and may not appear. If you want smarter suggestions,
  we can add a fuzzy fallback (e.g. an ä/ae/e normalization retry) — say the word.
- **dict.cc scraping is best-effort.** If the markup changes or a term has no hits and
  no suggestions, the app shows "No translation or suggestions".
