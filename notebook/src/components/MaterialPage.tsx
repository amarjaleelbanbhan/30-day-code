"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { MaterialPanel, type MaterialItem } from "./MaterialPanel";

export function MaterialPage({ course, material }: { course: { id: string; name: string }; material: MaterialItem }) {
  const router = useRouter();
  const params = useSearchParams();
  const [mats, setMats] = useState([material]);
  const page = Number(params.get("p") ?? 1) || 1;

  async function remove() {
    if (!confirm(`Delete ${material.filename}? It will be removed from course memory.`)) return;
    await api(`/api/materials/${material.id}`, { method: "DELETE" });
    router.replace(`/c/${course.id}`);
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
        <nav className="truncate text-fg-2"><Link href={`/c/${course.id}`} className="hover:text-fg">{course.name}</Link> / <span className="text-fg">{material.filename}</span></nav>
        <div className="flex gap-1">
          <a className="btn btn-ghost h-8 text-xs" href={`/api/materials/${material.id}/file`} download>Download</a>
          <button className="btn btn-ghost h-8 text-xs hover:text-danger" onClick={remove}>Delete</button>
        </div>
      </header>
      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1">
        <MaterialPanel courseId={course.id} lectureId={material.lectureId} materials={mats} onMaterials={setMats}
          selected={{ id: material.id, page }} onSelect={(_id, p) => router.replace(`?p=${p}`, { scroll: false })} />
      </div>
    </div>
  );
}
