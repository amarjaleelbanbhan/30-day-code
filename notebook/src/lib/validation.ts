import { z } from "zod";

const opt = (max: number) =>
  z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export const courseSchema = z.object({
  name: z.string().trim().min(1, "Course name is required").max(200),
  code: opt(50),
  instructor: opt(200),
  semester: opt(100),
  description: opt(5000),
});

export const lectureSchema = z.object({
  number: z.coerce.number().int().min(0).max(10000).optional().nullable(),
  title: z.string().trim().max(300).default(""),
  lectureDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
});

export const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(2000) });

// Tiptap JSON document. Structure is validated by the editor schema on load; here we bound size/shape.
export const noteSaveSchema = z.object({
  content: z.object({ type: z.literal("doc") }).passthrough(),
  plainText: z.string().max(2_000_000),
});

export const askSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  lectureId: z.string().uuid().optional().nullable(),
  /** course = course sources only (default); explain = course + clearly separated general explanation. */
  mode: z.enum(["course", "explain"]).default("course"),
});

export const aiActionSchema = z.object({
  action: z.enum(["structure", "revision", "explain", "summarize_slide", "missing_points", "examples", "flashcards", "quiz"]),
  lectureId: z.string().uuid(),
  text: z.string().max(100_000).optional(),
  materialId: z.string().uuid().optional(),
  pageNo: z.number().int().min(1).optional(),
});

export const MATERIAL_KINDS = ["slides", "notes", "book", "syllabus", "outline", "image", "other"] as const;
export const materialKindSchema = z.enum(MATERIAL_KINDS);

export const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

const QTYPES = ["mcq", "tf", "fill", "definition", "list", "short", "conceptual", "why", "comparison", "scenario", "indirect", "code", "diagram", "formula"] as const;
export const studyCreateSchema = z.object({
  kind: z.enum(["practice", "master", "weak", "review", "quick", "exam"]),
  scope: z.object({
    type: z.enum(["lecture", "lectures", "course", "concept", "weak", "due"]),
    lectureIds: z.array(z.string().uuid()).max(200).optional(),
    conceptIds: z.array(z.string().uuid()).max(50).optional(),
    label: z.string().max(200).optional(),
  }),
  config: z.object({
    types: z.union([z.literal("mixed"), z.array(z.enum(QTYPES)).min(1)]).default("mixed"),
    difficulty: z.union([z.literal("adaptive"), z.literal(1), z.literal(2), z.literal(3)]).default("adaptive"),
    count: z.number().int().min(1).max(60).optional(),
    timeLimitMin: z.number().int().min(1).max(300).optional(),
  }).default({ types: "mixed", difficulty: "adaptive" }),
});

export const studyAnswerSchema = z.object({
  answer: z.string().max(20000).optional(),
  dontKnow: z.boolean().optional(),
  drawing: z.object({ shapes: z.array(z.unknown()).max(5000), height: z.number().optional() }).passthrough().optional(),
  selfCheck: z.array(z.string().max(80)).max(20).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
});
