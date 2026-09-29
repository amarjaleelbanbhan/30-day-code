-- Core notebook schema: users, courses, lectures, materials, notes, course memory (chunks).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE courses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text,
  instructor  text,
  semester    text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_user_idx ON courses(user_id, updated_at DESC);

CREATE TABLE lectures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  number       integer,
  title        text NOT NULL DEFAULT '',
  lecture_date date,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lectures_course_idx ON lectures(course_id, position);

-- An uploaded file. lecture_id NULL = course-level material (syllabus, book, outline).
CREATE TABLE materials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lecture_id  uuid REFERENCES lectures(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'slides'
              CHECK (kind IN ('slides','notes','book','syllabus','outline','image','other')),
  filename    text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  storage_key text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  error       text,
  page_count  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX materials_course_idx ON materials(course_id);
CREATE INDEX materials_lecture_idx ON materials(lecture_id);

-- Extracted page/slide content, preserved with its number for citations.
CREATE TABLE document_pages (
  material_id   uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  page_no       integer NOT NULL,
  title         text,
  body          text NOT NULL DEFAULT '',
  speaker_notes text,
  PRIMARY KEY (material_id, page_no)
);

-- One notebook page per lecture (Tiptap JSON; sketches live inside as nodes).
CREATE TABLE notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lecture_id uuid NOT NULL UNIQUE REFERENCES lectures(id) ON DELETE CASCADE,
  content    jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}',
  plain_text text NOT NULL DEFAULT '',
  version    integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE note_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content    jsonb NOT NULL,
  plain_text text NOT NULL,
  reason     text NOT NULL DEFAULT 'autosave',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_versions_note_idx ON note_versions(note_id, created_at DESC);

-- Course memory: every retrievable piece, traceable to course / lecture / source / page / note section.
CREATE TABLE chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lecture_id   uuid REFERENCES lectures(id) ON DELETE CASCADE,
  material_id  uuid REFERENCES materials(id) ON DELETE CASCADE,
  note_id      uuid REFERENCES notes(id) ON DELETE CASCADE,
  source_type  text NOT NULL CHECK (source_type IN ('material','note')),
  content_type text NOT NULL,           -- slide | page | speaker_notes | document | note
  page_no      integer,
  section      text,
  ord          integer NOT NULL DEFAULT 0,
  text         text NOT NULL,
  tsv          tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english', coalesce(section, '')), 'A') ||
                 setweight(to_tsvector('english', text), 'B')) STORED,
  embedding    vector,
  embedding_model text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((material_id IS NULL) <> (note_id IS NULL))
);
CREATE INDEX chunks_course_idx ON chunks(course_id, lecture_id);
CREATE INDEX chunks_material_idx ON chunks(material_id);
CREATE INDEX chunks_note_idx ON chunks(note_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin(tsv);
CREATE INDEX chunks_trgm_idx ON chunks USING gin(text gin_trgm_ops);
