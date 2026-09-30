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
| Local OCR (Tesseract, English): photos/screenshots of printed slides, whiteboards and handouts, and scanned PDF pages with no text layer — searchable, cited and studyable like any other material; unreadable images are stored but never indexed | ✅ |
| Material panel beside notes: prev/next, zoom, search slides, copy, insert excerpt with citation, original PDF/image view | ✅ |
| Course memory: chunks linked to course / lecture / material / page-or-slide / note section | ✅ |
| Hybrid search: full-text (stemmed, ranked) + trigram fuzzy + optional vector similarity, fused with RRF | ✅ |
| Ask course / Recall lecture / Recall course with numbered, clickable citations to the exact slide, page or note section | ✅ |
| AI note actions (structure, revision notes, missing points, explain, examples, flashcards, quiz, summarize slide) — never overwrite notes; inserts are snapshotted first | ✅ |
| Command palette (`Ctrl/Cmd+K`), focus mode (`F`, `Esc`), light/dark/auto theme, tablet split view, phone layout | ✅ |

### Not built yet (next phases)
- Concept graph / concept map and cross-lecture relationship extraction.
- Handwriting recognition (OCR of strokes, and of handwritten photos) — drawings are indexed by their optional caption only; OCR is for printed text and English only.
- Infinite free-form canvas pages (drawings are blocks within the page flow), connector snapping.
- Full offline app shell (service worker); today edits made while the server is unreachable are kept locally and synced later, but pages must be opened once online.
- OAuth sign-in, login rate limiting, S3 storage adapter.

## Course memory & recall

```
upload ─► job queue ─► extract (slides/pages/speaker notes) ─► normalize ─► chunk (+lecture, slide/page, section, evidence class, hash)
                                  └─► course vocabulary + abbreviations stated in the text ─► embed (current model only) ─► concept index
note edit ─► autosave ─► debounced job ─► diff pieces by hash ─► insert/delete only changed pieces ─► embed only those
question ─► intent router ─► strategy-specific hybrid retrieval ─► context builder ─► (LLM) ─► citation validation ─► answer + evidence
```

* **Background jobs** (`src/lib/jobs.ts`) live in Postgres: they survive restarts, are debounced and retried, and failures surface in
  the UI as *Processing failed · Retry* / *Indexing failed · Retry*. Writing notes never waits on parsing or AI.
* **Hybrid search** (`src/lib/search.ts`): stemmed full-text with term-coverage ranking (slide titles weighted), exact-phrase bonus for
  words adjacent in the question, typo correction from the course's own vocabulary, abbreviations the material itself defines
  ("Process Control Block (PCB)", "also called task control block"), trigram similarity, and vector similarity — fused, then weighted by
  evidence class: slides/teacher notes › speaker notes › student notes › textbook › AI-generated notes. "What did sir say…" boosts
  speaker notes; "my notes" boosts student notes.
* **Intent routing** (`src/lib/intent.ts`): definition, source lookup ("where did we study…", "first introduced"), topic
  ("everything about…", examples, how it developed), comparison, cross-lecture, exam revision, recall lecture, recall course.
* **Recall course** is hierarchical: cached per-lecture summaries (invalidated by an evidence hash) → grouped reduction that fits the
  model's context window → synthesis with `[L5]` lecture links. Large lectures/topics use cited map-reduce.
* **Concept index** (`src/lib/concepts.ts`): candidates from titles, headings, "Term: …"/"A term is …" lines and stated
  abbreviations; mentions by phrase match; relations only by name containment or co-occurrence in ≥ 2 passages. No LLM, so no invented
  edges. Browse at *Course → Concepts*.
* **Answer modes**: *Course sources only* (default) never uses model knowledge and answers **“This was not found in your uploaded course
  material.”** when evidence is missing — decided before any model call when a question's subject doesn't occur in the course (or its
  rarest word never co-occurs with the rest, e.g. "quantum operating systems"). *Course + explanation* adds a separately generated,
  visually separate "Additional explanation — general knowledge" block that is never allowed to cite the course.
* **Citations** are built from stored identity only (lecture, slide/page, file, speaker notes, note section) and validated after
  generation; unknown numbers are removed. Clicking one previews the slide/page (prev/next, highlighted) and *Open* jumps to the exact
  slide, PDF page, or note block (highlighted).

## Study & exam mastery

`/c/<course>/study` (also: Workspace ▸ Study, `Ctrl/Cmd+K` → "Study…", concept pages ▸ Study / Master this).
Loop: **answer → grade → diagnose → teach → retest → mastery**.

* **Entry points**: practice (course / lectures / concepts), Master this lecture/concept, Weak areas, Due review (spaced), Quick 5, Exam practice.
* **Questions** (`src/lib/study/templates.ts`) are generated from facts literally stated in your material (definitions,
  labelled lists, enumerations, sibling contrasts) — definition, indirect, MCQ, true/false (incl. fair contrast traps),
  fill-in, comparison, list recall, odd-one-out, cross-lecture, diagram. Each stores its source chunks and a fingerprint;
  near-duplicates are rejected. With an LLM configured, generated questions are validated against the evidence (zod schema,
  grounding check, one corrective retry) and fall back to rule templates.
* **Grading** (`grade.ts`): rubric points with synonyms/negation/clause handling → Correct / Mostly / Partial / Incorrect /
  I don't know. Verdicts are always computed from points, never from a model's opinion. Misconceptions are detected from
  course contrasts (e.g. describing the heap with the text section's description) and tracked per concept.
* **Feedback**: what you missed, correct answer, why (quoted source), clickable citations; progressive hints (counted);
  "I don't know" → short teaching from your material → the concept returns later in a different format.
* **Mastery** (`mastery.ts`): per-level (remember → transfer) scores; easy recognition wins alone never reach *Mastered*;
  states Not started / Learning / Needs review / Strong / Mastered; SM-2 spacing for review.
* **Exam mode**: no hints or feedback until submit; then per-question solutions, breakdown by type, misconceptions, next steps.
* Sessions persist (resume after reload); attempts are immutable history.

Limits: drawings in diagram answers are self-checked against the listed parts (no vision grading). Rule grading
recognises paraphrases through a general synonym list and (if embeddings are configured) semantic similarity; unusual
wording can still be under-credited.

## AI setup — fully local, cloud, or search-only

Nothing requires AI: without it, search, "where did we study…", recall and concept pages work extractively from your material.

```bash
# Fully local (Ollama): any chat model + any embedding model you have pulled
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=<your chat model>
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=<your embedding model>

# Any OpenAI-compatible server (llama.cpp server, vLLM, LM Studio, OpenAI, …)
LLM_PROVIDER=openai   LLM_BASE_URL=http://localhost:8080/v1   LLM_MODEL=…   LLM_API_KEY=(optional)
EMBEDDING_PROVIDER=openai   EMBEDDING_BASE_URL=…/v1   EMBEDDING_MODEL=…

# Anthropic
LLM_PROVIDER=anthropic   LLM_API_KEY=…   LLM_MODEL=…
```

The context window is detected from Ollama (`/api/show`, capped at 16k; override with `LLM_CONTEXT_TOKENS`) and every prompt is
budgeted to fit it. Each vector stores the embedder identity; after switching embedding models, old vectors are ignored until
re-embedded (`npm run reindex -- --stale`). `EMBEDDING_MIN_SIMILARITY` (default 0.5) tunes how much vector similarity can vouch for a
question whose words don't appear in the course.

## OCR

Runs inside the background extract job (never in a request), fully offline: `tesseract.js` with the English model from
`@tesseract.js-data/eng`. A page is OCR'd when it is an image upload or a PDF page with (almost) no text layer. Output below
`OCR_MIN_CONFIDENCE` (default 60) or with fewer than 3 words is discarded, so blurry photos, handwriting and diagrams can't
become search hits, concepts or study questions. OCR'd pages get no title (a misread first line must not become a concept).
`OCR_MAX_PAGES` (default 300) caps OCR per file; `OCR_LANG_PATH` points at a directory holding other `*.traineddata.gz` models.

## Developer tools

* `/c/<courseId>/debug` (only when `NODE_ENV≠production` or `NB_DEBUG=1`): provider capabilities, index/embedding health, job queue,
  and for any query — intent, term analysis, keyword/semantic/fuzzy/fused lists, selected context, full prompts, citation checks.
  Reindex / re-embed buttons.
* `npm run reindex -- --course "<name|id>" [--embeddings-only]`, `npm run reindex -- --stale`
* `npm run debug:search -- "<course name>" "query" …`, `npm run bench` (latency on a synthetic 60-lecture course)

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

`tests/memory.test.ts` runs retrieval/recall checks on a deterministic 7-lecture OS course (`tests/fixtures/make_os_course.py`) with
deliberate traps: synonyms, typos, abbreviations, plural/singular, speaker-note-only and student-note-only facts, a textbook passage that
contradicts the lecture, and questions about things not in the course. LLM behaviour is tested against a stub Ollama server (prompt
construction, context budgets, citation validation, modes). The semantic block runs with real local embeddings when
`TEST_OLLAMA_URL` points at an Ollama-compatible embedding server — e.g. `python3 tests/support/ollama_compat.py` (WordLlama, from PyPI).

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
