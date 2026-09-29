# Notebook — lecture notes & recall

A calm, distraction-free notebook for university students:
**open → course → lecture → write, draw or upload → study.**
Everything the student writes or uploads becomes searchable, citable course memory.

## What works today

| Area | Status |
| --- | --- |
| Email/password auth (scrypt, http-only session cookies, same-origin checks) | ✅ |
| Courses, lectures (numbered, dated, drag-and-drop + keyboard reordering) | ✅ |
| Rich-text notes (Tiptap): headings, lists, checklists, tables, code, quotes, callouts (`!> `), links, highlight, inline/display math (KaTeX), Markdown shortcuts | ✅ |
| Drawing blocks inside notes: pen, highlighter, eraser, select/marquee + move, line, arrow, box, circle, text, colours, widths, undo/redo, resizable, stylus palm rejection | ✅ |
| Local-first autosave (localStorage → server), `Saved / Saving… / Offline` status, offline edits re-synced on return, `Ctrl/Cmd+S` to force sync | ✅ |
| Version history: automatic snapshots (every 10 min, before AI inserts and restores), view, compare (line diff), restore | ✅ |
| Uploads with signature validation + size limit: PDF, PPTX, DOCX, TXT, Markdown, images | ✅ |
| Extraction: PPTX slide titles/bullets/tables/speaker notes (in presentation order), PDF per page, DOCX/Markdown by section | ✅ |
| Material panel beside notes: prev/next, zoom, search slides, copy, insert excerpt with citation, original PDF/image view | ✅ |
| Course memory: chunks linked to course / lecture / material / page-or-slide / note section | ✅ |
| Hybrid search: full-text (stemmed, ranked) + trigram fuzzy + optional vector similarity, fused with RRF | ✅ |
| Ask course / Recall lecture / Recall course with numbered, clickable citations to the exact slide, page or note section | ✅ |
| AI note actions (structure, revision notes, missing points, explain, examples, flashcards, quiz, summarize slide) — never overwrite notes; inserts are snapshotted first | ✅ |
| Command palette (`Ctrl/Cmd+K`), focus mode (`F`, `Esc`), light/dark/auto theme, tablet split view, phone layout | ✅ |

### Not built yet (next phases)
- Interactive study mode (active-recall grading, spaced flashcards, stored quizzes) — today quizzes/flashcards are generated as text.
- Concept graph / concept map and cross-lecture relationship extraction.
- Handwriting recognition (OCR of strokes) and OCR of image uploads — drawings are indexed by their optional caption only.
- Infinite free-form canvas pages (drawings are blocks within the page flow), connector snapping.
- Full offline app shell (service worker); today edits made while the server is unreachable are kept locally and synced later, but pages must be opened once online.
- OAuth sign-in, login rate limiting, S3 storage adapter.

## AI: grounded, provider-independent

`src/lib/ai/provider.ts` defines `LLM` and `Embedder` interfaces with Anthropic and OpenAI-compatible implementations (keys stay server-side).
Answers are built only from retrieved, numbered sources; the prompt requires citations, separates *course material*, *your notes* and
*general knowledge*, and replies **“This was not found in your uploaded course material.”** when retrieval finds nothing (the student can then ask for a labelled general explanation).

Without an LLM configured, Ask/Recall still work in **retrieval mode**: they return the lecture outline and the cited source excerpts directly.
Without an embedding endpoint, search is keyword + fuzzy; configure `EMBEDDING_BASE_URL` (any OpenAI-compatible `/embeddings`, e.g. OpenAI or a local Ollama) for semantic search.

```
upload → detect & validate → extract pages/slides → chunk (+section, page) → tsvector/trigram (+ embeddings)
question → intent (recall lecture N / recall course / ask) → hybrid retrieval → numbered sources → LLM → cited answer
```

## Run locally

Requires Node 20+ and PostgreSQL 16 with `pgvector` and `pg_trgm`.

```bash
cp .env.example .env.local        # set DATABASE_URL, optionally LLM + embedding settings
npm install
npm run migrate                   # uses DATABASE_URL
npm run dev
```

Tests (unit + integration against a real database; defaults to `postgres://nb:nb@localhost:5432/notebook_test`):

```bash
TEST_DATABASE_URL=postgres://… npm test
npm run typecheck
```

## Layout

```
migrations/          SQL migrations (users, sessions, courses, lectures, materials, document_pages, notes, note_versions, chunks)
src/lib/             server logic — repo.ts (user-scoped data access), ingest.ts, search.ts, rag.ts, intent.ts, extract/, ai/
src/app/api/         route handlers (all authenticated via lib/api.ts `route()`)
src/components/      UI — Workspace (lecture page), editor/ (Tiptap, Sketch, autosave), MaterialPanel, AskPanel, CommandPalette
tests/               vitest unit + integration tests, fixtures
```

## Keyboard

`Ctrl/Cmd+K` commands · `Ctrl/Cmd+S` sync now · `Ctrl/Cmd+F` / `Ctrl/Cmd+Shift+F` search · `Ctrl/Cmd+Enter` ask ·
`F` focus mode · `D` insert drawing · `[` lectures sidebar · `]` material panel · `←/→` slides (in material panel) · `Esc` close/exit.
Single-key shortcuts never fire while typing.
