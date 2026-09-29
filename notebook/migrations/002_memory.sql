-- Course memory v2: job queue, embedding status, chunk identity, lexicon/aliases, concept index, lecture summaries.

-- Background jobs (extraction, note indexing, embeddings, concept index, summaries). Survives restarts; retryable.
CREATE TABLE jobs (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  target_id  uuid NOT NULL,
  course_id  uuid REFERENCES courses(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','failed')),
  attempts   integer NOT NULL DEFAULT 0,
  error      text,
  run_after  timestamptz NOT NULL DEFAULT now(),
  locked_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_one_open ON jobs(kind, target_id) WHERE status IN ('pending','failed');
CREATE INDEX jobs_due ON jobs(run_after) WHERE status = 'pending';

-- Embedding status per source ('none' = no embedder configured).
ALTER TABLE materials ADD COLUMN embed_status text NOT NULL DEFAULT 'none'
  CHECK (embed_status IN ('none','pending','processing','ready','failed'));
ALTER TABLE materials ADD COLUMN embed_error text;
ALTER TABLE notes ADD COLUMN embed_status text NOT NULL DEFAULT 'none'
  CHECK (embed_status IN ('none','pending','processing','ready','failed'));
ALTER TABLE notes ADD COLUMN embed_error text;

-- Chunk identity & evidence class.
--   source_kind: slides | teacher_notes | book | outline | other | student_notes | ai_note
--   content_type: slide | speaker_notes | page | document | note | drawing | ai_note
ALTER TABLE chunks ADD COLUMN source_kind text;
ALTER TABLE chunks ADD COLUMN content_hash text;
ALTER TABLE chunks ADD COLUMN anchor text;          -- note chunks: text used to locate the note block
UPDATE chunks ch SET source_kind = CASE m.kind WHEN 'notes' THEN 'teacher_notes' WHEN 'syllabus' THEN 'outline' ELSE m.kind END
  FROM materials m WHERE m.id = ch.material_id;
UPDATE chunks SET source_kind = 'student_notes' WHERE note_id IS NOT NULL;
UPDATE chunks SET content_hash = md5(coalesce(section, '') || E'\x1f' || text);
ALTER TABLE chunks ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE chunks ALTER COLUMN content_hash SET NOT NULL;

CREATE INDEX chunks_embed_idx ON chunks(course_id, embedding_model);
CREATE INDEX chunks_page_idx ON chunks(material_id, page_no, ord);

-- Course vocabulary for typo tolerance (trigram nearest term) and abbreviation aliases found in the material.
CREATE TABLE course_terms (
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  term      text NOT NULL,
  PRIMARY KEY (course_id, term)
);
CREATE INDEX course_terms_trgm ON course_terms USING gin (term gin_trgm_ops);

CREATE TABLE course_aliases (
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  alias      text NOT NULL,   -- lower-case abbreviation, e.g. 'pcb'
  expansion  text NOT NULL,   -- lower-case phrase, e.g. 'process control block'
  chunk_id   uuid REFERENCES chunks(id) ON DELETE SET NULL,
  PRIMARY KEY (course_id, alias, expansion)
);

-- Concept index: candidates extracted from titles, headings, definitions and abbreviations. Relations only from evidence.
CREATE TABLE concepts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name          text NOT NULL,
  norm          text NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}',
  origin        text NOT NULL,           -- title | heading | definition | acronym
  mention_count integer NOT NULL DEFAULT 0,
  lecture_count integer NOT NULL DEFAULT 0,
  first_position integer,
  UNIQUE (course_id, norm)
);
CREATE TABLE concept_mentions (
  concept_id uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  chunk_id   uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  role       text NOT NULL,              -- title | definition | mention
  PRIMARY KEY (concept_id, chunk_id)
);
CREATE INDEX concept_mentions_chunk ON concept_mentions(chunk_id);
CREATE TABLE concept_relations (
  a            uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  b            uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind         text NOT NULL,            -- part_of (a is a kind/part of b by name) | cooccurs
  evidence     integer NOT NULL,         -- number of chunks supporting the relation
  sample_chunk uuid REFERENCES chunks(id) ON DELETE SET NULL,
  PRIMARY KEY (a, b, kind)
);
CREATE INDEX concept_relations_b ON concept_relations(b);

-- Cached per-lecture summaries for hierarchical course recall (invalidated by evidence hash).
CREATE TABLE lecture_summaries (
  lecture_id    uuid PRIMARY KEY REFERENCES lectures(id) ON DELETE CASCADE,
  evidence_hash text NOT NULL,
  summary       text NOT NULL,
  model         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
