-- Active study: generated questions (with provenance), sessions, immutable attempts, per-concept mastery & review schedule.

CREATE TABLE study_questions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  concept_id      uuid REFERENCES concepts(id) ON DELETE SET NULL,     -- primary concept tested
  concept_ids     uuid[] NOT NULL DEFAULT '{}',                         -- all concepts involved (comparison / cross-lecture)
  concept_name    text NOT NULL,                                        -- survives concept-index rebuilds
  lecture_ids     uuid[] NOT NULL DEFAULT '{}',
  qtype           text NOT NULL,     -- mcq | tf | fill | definition | short | list | conceptual | why | comparison | scenario | indirect | code | diagram | formula
  level           text NOT NULL,     -- remember | understand | apply | analyze | transfer
  difficulty      smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
  prompt          text NOT NULL,
  options         jsonb,             -- MCQ: [{key, text, correct, why}]
  answer          text NOT NULL,     -- model answer shown after the attempt
  rubric          jsonb NOT NULL,    -- [{id, text, keywords[], weight, essential}]
  misconceptions  jsonb NOT NULL DEFAULT '[]',   -- [{id, claim, cues[], correction}]
  hints           jsonb NOT NULL DEFAULT '[]',   -- progressive, revealed one at a time
  explanation     text NOT NULL DEFAULT '',
  evidence        jsonb NOT NULL,    -- snapshot of cited sources: [{n, chunkId, label, excerpt, lectureId, materialId, pageNo, noteId, anchor, kind, contentType}]
  generator       text NOT NULL,     -- rule:<template> | llm:<provider:model>
  fingerprint     text NOT NULL,     -- normalized content-word signature for novelty checks
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_questions_course_concept ON study_questions(course_id, concept_id);

-- Relational provenance (chunks may be re-created by reindexing; the evidence snapshot above keeps citations working).
CREATE TABLE question_sources (
  question_id uuid NOT NULL REFERENCES study_questions(id) ON DELETE CASCADE,
  chunk_id    uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, chunk_id)
);
CREATE INDEX question_sources_chunk ON question_sources(chunk_id);

CREATE TABLE study_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('practice','master','weak','review','quick','exam')),
  scope        jsonb NOT NULL,       -- {type: lecture|lectures|course|concept|weak|due, lectureIds?, conceptIds?, label}
  config       jsonb NOT NULL,       -- {types[], difficulty, count?, timeLimitMin?}
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  state        jsonb NOT NULL DEFAULT '{}',   -- planner state: retest queue, current difficulty, concept order
  summary      jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  deadline_at  timestamptz,
  finished_at  timestamptz
);
CREATE INDEX study_sessions_user_course ON study_sessions(user_id, course_id, started_at DESC);
CREATE INDEX study_sessions_active ON study_sessions(user_id, course_id) WHERE status = 'active';

CREATE TABLE study_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES study_questions(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  purpose      text NOT NULL DEFAULT 'new',   -- new | retest | check (comprehension check after teaching)
  hints_used   smallint NOT NULL DEFAULT 0,
  draft        jsonb,                          -- exam answers before submission / drawing awaiting self-check
  shown_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, position)
);
CREATE INDEX study_items_session ON study_items(session_id, position);

-- Immutable attempt history (no update route exists).
CREATE TABLE study_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL UNIQUE REFERENCES study_items(id) ON DELETE CASCADE,
  question_id     uuid NOT NULL REFERENCES study_questions(id) ON DELETE CASCADE,
  concept_id      uuid REFERENCES concepts(id) ON DELETE SET NULL,
  answer          text NOT NULL DEFAULT '',
  drawing         jsonb,
  verdict         text NOT NULL CHECK (verdict IN ('correct','mostly','partial','incorrect','dont_know')),
  score           real NOT NULL,
  points          jsonb NOT NULL DEFAULT '[]',     -- [{id, text, status: met|partial|missing}]
  misconceptions  jsonb NOT NULL DEFAULT '[]',     -- [{claim, correction}]
  grader          text NOT NULL,                   -- rule | llm:<model> | self | choice
  hints_used      smallint NOT NULL DEFAULT 0,
  duration_ms     integer,
  mastery_before  real,
  mastery_after   real,
  answered_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_attempts_user_concept ON study_attempts(user_id, concept_id, answered_at DESC);
CREATE INDEX study_attempts_session ON study_attempts(session_id);

-- Per-user, per-concept mastery and spaced-review schedule.
CREATE TABLE concept_mastery (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id      uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  attempts        integer NOT NULL DEFAULT 0,
  correct         integer NOT NULL DEFAULT 0,
  partial         integer NOT NULL DEFAULT 0,
  incorrect       integer NOT NULL DEFAULT 0,
  levels          jsonb NOT NULL DEFAULT '{}',     -- {remember: {n, s}, understand: …} exponentially-weighted score per cognitive level
  score           real NOT NULL DEFAULT 0,          -- internal 0..1
  state           text NOT NULL DEFAULT 'not_started',
  misconceptions  integer NOT NULL DEFAULT 0,
  retained        integer NOT NULL DEFAULT 0,       -- correct recalls after a ≥ 20 h gap
  reps            integer NOT NULL DEFAULT 0,       -- consecutive successful reviews (SM-2)
  ease            real NOT NULL DEFAULT 2.5,
  interval_days   real NOT NULL DEFAULT 0,
  last_reviewed   timestamptz,
  next_review     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, concept_id)
);
CREATE INDEX concept_mastery_course ON concept_mastery(user_id, course_id);
CREATE INDEX concept_mastery_due ON concept_mastery(user_id, course_id, next_review);

CREATE TABLE misconception_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  concept_id  uuid REFERENCES concepts(id) ON DELETE SET NULL,
  attempt_id  uuid NOT NULL REFERENCES study_attempts(id) ON DELETE CASCADE,
  claim       text NOT NULL,
  correction  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX misconception_log_user_concept ON misconception_log(user_id, concept_id, created_at DESC);
