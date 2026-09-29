"use client";
import { api } from "@/lib/client";
import type { QType } from "@/lib/study/types";

export type StartOpts = {
  kind: "practice" | "master" | "weak" | "review" | "quick" | "exam";
  scope: { type: "lecture" | "lectures" | "course" | "concept" | "weak" | "due"; lectureIds?: string[]; conceptIds?: string[]; label?: string };
  config?: { types?: QType[] | "mixed"; difficulty?: "adaptive" | 1 | 2 | 3; count?: number; timeLimitMin?: number };
};

/** Creates a study session and returns its URL. Throws with the server's message (e.g. nothing to study yet). */
export async function startStudy(courseId: string, o: StartOpts): Promise<string> {
  const r = await api<{ id: string }>(`/api/courses/${courseId}/study`, {
    method: "POST",
    json: { kind: o.kind, scope: o.scope, config: { types: "mixed", difficulty: "adaptive", ...o.config } },
  });
  return `/c/${courseId}/study/${r.id}`;
}
