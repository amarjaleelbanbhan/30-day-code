"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, isTyping, pad2, timeAgo } from "@/lib/client";
import { ACCEPT } from "@/lib/extract/accept";
import { AskPanel, type PanelTab } from "./AskPanel";
import { useRegisterCommands, type Command } from "./commands";
import { ThemeToggle } from "./ThemeToggle";
import { uploadFile } from "./upload";

export type LectureItem = { id: string; number: number | null; title: string; date: string | null; materials: string[]; lastEdited: string };
type CourseMat = { id: string; filename: string; kind: string; status: string; error: string | null };
type Course = { id: string; name: string; code: string | null; instructor: string | null; semester: string | null };

export function CourseView({ course, lectures: initial, courseMaterials: initialMats }: { course: Course; lectures: LectureItem[]; courseMaterials: CourseMat[] }) {
  const router = useRouter();
  const [lectures, setLectures] = useState(initial);
  const [mats, setMats] = useState(initialMats);
  const [creating, setCreating] = useState(initial.length === 0);
  const [panel, setPanel] = useState<{ tab: PanelTab; q?: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => setLectures(initial), [initial]);

  const openPanel = useCallback((tab: PanelTab, q?: string) => setPanel({ tab, q }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); openPanel("search"); }
      else if (mod && e.key === "Enter") { e.preventDefault(); openPanel("ask"); }
      else if (e.key === "Escape" && panel && !isTyping(e)) setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPanel, panel]);

  // Poll while course-level materials are processing.
  useEffect(() => {
    if (!mats.some((m) => m.status === "pending" || m.status === "processing")) return;
    const t = setInterval(async () => {
      const r = await api<{ materials: (CourseMat & { lecture_id: string | null })[] }>(`/api/courses/${course.id}/materials`).catch(() => null);
      if (r) setMats(r.materials.filter((m) => !m.lecture_id));
    }, 2000);
    return () => clearInterval(t);
  }, [mats, course.id]);

  const commands = useMemo<Command[]>(() => [
    { id: "new-lecture", label: "New lecture", run: () => setCreating(true) },
    { id: "search", label: "Search course", shortcut: "Ctrl ⇧ F", run: () => openPanel("search") },
    { id: "ask", label: "Ask AI", shortcut: "Ctrl ↵", run: () => openPanel("ask") },
    { id: "recall-course", label: "Recall course", run: () => openPanel("ask", "Recall course") },
    { id: "quiz", label: "Create quiz from all lectures", run: () => openPanel("ask", "Create quiz questions from all lectures, with answers at the end") },
    { id: "home", label: "All courses", run: () => router.push("/") },
    ...lectures.map((l) => ({ id: `open-${l.id}`, label: `Lecture ${pad2(l.number)}${l.title ? ` — ${l.title}` : ""}`, group: "Open lecture", run: () => router.push(`/c/${course.id}/l/${l.id}`) })),
    ...lectures.filter((l) => l.number != null).map((l) => ({ id: `recall-${l.id}`, label: `Recall lecture ${pad2(l.number)}`, group: "Recall", run: () => openPanel("ask", `Recall lecture ${l.number}`) })),
  ], [lectures, course.id, router, openPanel]);
  useRegisterCommands("course", commands);

  async function persistOrder(next: LectureItem[]) {
    setLectures(next);
    await api(`/api/courses/${course.id}/lectures/order`, { method: "PUT", json: { ids: next.map((l) => l.id) } }).catch(() => router.refresh());
  }
  const move = (id: string, to: number) => {
    const from = lectures.findIndex((l) => l.id === id);
    if (from < 0 || to < 0 || to >= lectures.length || from === to) return;
    const next = [...lectures];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    void persistOrder(next);
  };

  async function deleteCourse() {
    if (!confirm(`Delete “${course.name}” with all its lectures, notes and files? This cannot be undone.`)) return;
    await api(`/api/courses/${course.id}`, { method: "DELETE" });
    router.replace("/");
  }

  return (
    <div className="flex min-h-dvh">
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:py-12">
        <nav className="mb-6 flex items-center justify-between text-sm text-fg-2">
          <Link href="/" className="hover:text-fg">← Courses</Link>
          <ThemeToggle />
        </nav>
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{course.name}</h1>
          <p className="mt-1 text-sm text-fg-2">{[course.code, course.instructor, course.semester].filter(Boolean).join(" · ")}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New Lecture</button>
            <button className="btn" onClick={() => openPanel("search")}>Search Course</button>
            <button className="btn" onClick={() => openPanel("ask")}>Ask Course AI</button>
            <button className="btn" onClick={() => openPanel("ask", "Recall course")}>Recall Course</button>
          </div>
        </header>

        {creating && <NewLecture courseId={course.id} nextNumber={Math.max(0, ...lectures.map((l) => l.number ?? 0)) + 1} onCancel={lectures.length ? () => setCreating(false) : undefined} />}

        <section aria-labelledby="lectures-h" className="mt-6">
          <h2 id="lectures-h" className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Lectures</h2>
          {lectures.length === 0 && !creating && <p className="text-sm text-fg-2">No lectures yet.</p>}
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface empty:hidden">
            {lectures.map((l, i) => (
              <li key={l.id} draggable
                onDragStart={(e) => { setDragId(l.id); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== l.id) { const from = lectures.findIndex((x) => x.id === dragId); const next = [...lectures]; const [x] = next.splice(from, 1); next.splice(i, 0, x!); setLectures(next); } }}
                onDragEnd={() => { if (dragId) void persistOrder(lectures); setDragId(null); }}
                className={`group flex items-center gap-3 px-4 py-3 ${dragId === l.id ? "opacity-50" : ""}`}>
                <span className="cursor-grab select-none text-fg-2 opacity-40 group-hover:opacity-100" aria-hidden>⋮⋮</span>
                <Link href={`/c/${course.id}/l/${l.id}`} className="min-w-0 flex-1">
                  <span className="block text-[15px]">
                    <span className="mr-2 tabular-nums text-fg-2">{pad2(l.number)}</span>
                    <span className="font-medium">{l.title || "Untitled lecture"}</span>
                  </span>
                  <span className="block truncate text-xs text-fg-2">
                    {[l.date && new Date(l.date + "T00:00").toLocaleDateString(), l.materials.join(", "), `edited ${timeAgo(l.lastEdited)}`].filter(Boolean).join(" · ")}
                  </span>
                </Link>
                <span className="flex shrink-0 gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <button className="btn btn-ghost h-7 px-1.5 text-xs" aria-label="Move up" onClick={() => move(l.id, i - 1)} disabled={i === 0}>↑</button>
                  <button className="btn btn-ghost h-7 px-1.5 text-xs" aria-label="Move down" onClick={() => move(l.id, i + 1)} disabled={i === lectures.length - 1}>↓</button>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <CourseMaterials courseId={course.id} mats={mats} setMats={setMats} />

        <footer className="mt-16 flex items-center justify-between text-xs text-fg-2">
          <span><span className="kbd">Ctrl K</span> commands</span>
          <button className="hover:text-danger" onClick={deleteCourse}>Delete course</button>
        </footer>
      </main>
      {panel && (
        <div className="fixed inset-y-0 right-0 z-40 w-full border-l border-border shadow-xl sm:w-[480px]">
          <AskPanel courseId={course.id} courseName={course.name} tab={panel.tab} initialQuestion={panel.q}
            onTab={(tab) => setPanel({ tab })} onClose={() => setPanel(null)} />
        </div>
      )}
    </div>
  );
}

function CourseMaterials({ courseId, mats, setMats }: { courseId: string; mats: CourseMat[]; setMats: (m: CourseMat[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("outline");
  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const added: CourseMat[] = [];
    for (const f of Array.from(files)) {
      try {
        const m = await uploadFile(courseId, f, { kind });
        added.push({ id: m.id, filename: m.filename, kind: m.kind, status: m.status, error: null });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      }
    }
    setMats([...mats, ...added]);
  }
  return (
    <section aria-labelledby="cm-h" className="mt-10">
      <h2 id="cm-h" className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Course material</h2>
      {mats.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {mats.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3">
              <Link href={`/c/${courseId}/m/${m.id}`} className="truncate hover:underline">{m.filename}</Link>
              <span className="shrink-0 text-xs text-fg-2">{m.kind} · <MaterialStatus status={m.status} error={m.error} /></span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className="input h-9 w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Material type">
          <option value="outline">Course outline</option><option value="syllabus">Syllabus</option>
          <option value="book">Book</option><option value="notes">Teacher notes</option><option value="other">Other</option>
        </select>
        <label className="btn cursor-pointer">Upload<input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} /></label>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

export function MaterialStatus({ status, error }: { status: string; error?: string | null }) {
  if (status === "ready") return <span>indexed</span>;
  if (status === "failed") return <span className="text-danger" title={error ?? ""}>could not read</span>;
  return <span>reading…</span>;
}

function NewLecture({ courseId, nextNumber, onCancel }: { courseId: string; nextNumber: number; onCancel?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { lecture } = await api<{ lecture: { id: string } }>(`/api/courses/${courseId}/lectures`, {
        method: "POST", json: { number: f.get("number") || null, title: f.get("title"), lectureDate: f.get("date") || null },
      });
      const files = f.getAll("files").filter((x): x is File => x instanceof File && x.size > 0);
      const kind = String(f.get("kind") || "slides");
      const failures: string[] = [];
      await Promise.all(files.map((file) => uploadFile(courseId, file, { lectureId: lecture.id, kind }).catch((err: Error) => failures.push(err.message))));
      if (failures.length) alert(`Some files could not be uploaded:\n${failures.join("\n")}`);
      router.push(`/c/${courseId}/l/${lecture.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create lecture");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid grid-cols-[5rem_1fr] gap-3 sm:grid-cols-[5rem_1fr_10rem]">
        <div><label className="label" htmlFor="number">No.</label><input className="input" id="number" name="number" type="number" min={0} defaultValue={nextNumber} /></div>
        <div><label className="label" htmlFor="title">Title</label><input className="input" id="title" name="title" maxLength={300} autoFocus placeholder="Processes" /></div>
        <div className="col-span-2 sm:col-span-1"><label className="label" htmlFor="date">Date</label><input className="input" id="date" name="date" type="date" defaultValue={today} /></div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="files">Material (PPTX, PDF, DOCX, TXT, Markdown, images)</label>
          <input id="files" name="files" type="file" multiple accept={ACCEPT} className="text-sm" />
        </div>
        <select name="kind" className="input h-9 w-auto" aria-label="Material type" defaultValue="slides">
          <option value="slides">Lecture slides</option><option value="notes">Teacher notes</option>
          <option value="book">Textbook section</option><option value="other">Other</option>
        </select>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create & start writing"}</button>
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
