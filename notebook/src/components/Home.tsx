"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { ACCEPT } from "@/lib/extract/accept";
import { useRegisterCommands, type Command } from "./commands";
import { ThemeToggle } from "./ThemeToggle";
import { uploadFile } from "./upload";

type CourseItem = { id: string; name: string; code: string | null; semester: string | null; instructor: string | null; lectureCount: number };

export function Home({ email, courses }: { email: string; courses: CourseItem[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(courses.length === 0);

  const commands = useMemo<Command[]>(() => [
    { id: "add-course", label: "Add course", run: () => setAdding(true) },
    ...courses.map((c) => ({ id: `open-${c.id}`, label: c.name, group: "Open course", run: () => router.push(`/c/${c.id}`) })),
  ], [courses, router]);
  useRegisterCommands("home", commands);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 sm:py-16">
      <header className="mb-10 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">My Courses</h1>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <button className="btn btn-ghost h-8 px-2 text-xs text-fg-2" onClick={logout} title={email}>Sign out</button>
        </div>
      </header>

      {courses.length > 0 && (
        <ul className="mb-6 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {courses.map((c) => (
            <li key={c.id}>
              <Link href={`/c/${c.id}`} className="flex items-baseline justify-between gap-4 px-5 py-4 hover:bg-muted">
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-fg-2">
                    {[c.code, c.instructor, c.semester].filter(Boolean).join(" · ") || " "}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-fg-2">{c.lectureCount} {c.lectureCount === 1 ? "lecture" : "lectures"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {adding ? <AddCourse onCancel={courses.length ? () => setAdding(false) : undefined} /> :
        <button className="btn" onClick={() => setAdding(true)}>+ Add Course</button>}

      <p className="mt-16 text-xs text-fg-2"><span className="kbd">Ctrl K</span> commands</p>
    </main>
  );
}

function AddCourse({ onCancel }: { onCancel?: () => void }) {
  const router = useRouter();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { course } = await api<{ course: { id: string } }>("/api/courses", {
        method: "POST",
        json: Object.fromEntries(["name", "code", "instructor", "semester", "description"].map((k) => [k, f.get(k) ?? ""])),
      });
      for (const [field, kind] of [["outline", "outline"], ["book", "book"]] as const) {
        const file = f.get(field);
        if (file instanceof File && file.size) await uploadFile(course.id, file, { kind });
      }
      router.push(`/c/${course.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create course");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div>
        <label className="label" htmlFor="name">Course name</label>
        <input className="input" id="name" name="name" required maxLength={200} autoFocus placeholder="Operating Systems" />
      </div>
      {more ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="code">Code</label><input className="input" id="code" name="code" maxLength={50} /></div>
          <div><label className="label" htmlFor="instructor">Instructor</label><input className="input" id="instructor" name="instructor" maxLength={200} /></div>
          <div><label className="label" htmlFor="semester">Semester</label><input className="input" id="semester" name="semester" maxLength={100} /></div>
          <div className="sm:col-span-3"><label className="label" htmlFor="description">Description</label>
            <textarea className="input" id="description" name="description" rows={2} maxLength={5000} /></div>
          <div className="sm:col-span-3 grid gap-4 sm:grid-cols-2">
            <div><label className="label" htmlFor="outline">Course outline / syllabus</label>
              <input className="text-sm" id="outline" name="outline" type="file" accept={ACCEPT} /></div>
            <div><label className="label" htmlFor="book">Book</label>
              <input className="text-sm" id="book" name="book" type="file" accept={ACCEPT} /></div>
          </div>
        </div>
      ) : (
        <button type="button" className="text-sm text-fg-2 underline-offset-2 hover:underline" onClick={() => setMore(true)}>
          Add details, outline or book (optional)
        </button>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create course"}</button>
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
