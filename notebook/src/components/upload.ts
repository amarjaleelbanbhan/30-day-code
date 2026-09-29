"use client";
import { ApiError } from "@/lib/client";

export type UploadedMaterial = { id: string; filename: string; status: string; kind: string; lecture_id: string | null };

export async function uploadFile(courseId: string, file: File, opts: { lectureId?: string; kind?: string } = {}): Promise<UploadedMaterial> {
  const fd = new FormData();
  fd.set("file", file);
  if (opts.lectureId) fd.set("lectureId", opts.lectureId);
  if (opts.kind) fd.set("kind", opts.kind);
  const res = await fetch(`/api/courses/${courseId}/materials`, { method: "POST", body: fd });
  const data = (await res.json().catch(() => ({}))) as { material?: UploadedMaterial; error?: string };
  if (!res.ok || !data.material) throw new ApiError(res.status, `${file.name}: ${data.error ?? "upload failed"}`);
  return data.material;
}
