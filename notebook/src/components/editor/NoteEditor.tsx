"use client";
import Highlight from "@tiptap/extension-highlight";
import Mathematics from "@tiptap/extension-mathematics";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Callout } from "./Callout";
import { Sketch } from "./Sketch";
import { readDraft, useNoteSync, type SyncStatus } from "./useNoteSync";

type Doc = { type: "doc"; content?: unknown[] };

export type EditorApi = { editor: Editor; flush: (reason?: "ai") => Promise<void>; status: SyncStatus };

type Props = {
  lectureId: string;
  initial: Doc;
  serverUpdatedAt: string;
  compactToolbar?: boolean;
  onApi: (api: EditorApi) => void;
};

export function NoteEditor({ lectureId, initial, serverUpdatedAt, compactToolbar, onApi }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const sync = useNoteSync(lectureId, () => (editorRef.current && !editorRef.current.isDestroyed ? (editorRef.current.getJSON() as Doc) : null));

  // Prefer an unsynced local draft newer than the server copy (e.g. written offline or before a crash).
  const [{ draft, useDraft }] = useState(() => {
    const d = typeof window !== "undefined" ? readDraft(lectureId) : null;
    return { draft: d, useDraft: !!d?.dirty && d.ts > new Date(serverUpdatedAt).getTime() };
  });

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"], HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
      }),
      Placeholder.configure({ placeholder: "Start writing…  (Markdown works: #, -, [ ], >, ```; $$x^2$$ for math; press D outside the page to draw)" }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      Highlight,
      Mathematics.configure({
        katexOptions: { throwOnError: false, trust: false },
        inlineOptions: { onClick: (node, pos) => editMath(editorRef.current, node.attrs.latex as string, pos, "inline") },
        blockOptions: { onClick: (node, pos) => editMath(editorRef.current, node.attrs.latex as string, pos, "block") },
      }),
      Callout,
      Sketch,
    ],
    content: normalize(useDraft ? draft!.content : initial) as JSONContent,
    editorProps: { attributes: { class: "nb-editor", "aria-label": "Lecture notes", spellcheck: "true" } },
    onUpdate: () => sync.onChange(),
  }, [lectureId]);

  useEffect(() => {
    editorRef.current = editor;
    if (editor && useDraft) sync.markDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    if (editor) onApi({ editor, flush: sync.flush, status: sync.status });
  }, [editor, sync.flush, sync.status, onApi]);

  if (!editor) return <div className="nb-editor text-fg-2" aria-busy>Loading notes…</div>;
  return (
    <>
      <Toolbar editor={editor} compact={compactToolbar} />
      <EditorContent editor={editor} />
    </>
  );
}

/** An empty stored doc has no blocks; give it one paragraph so the caret and placeholder appear. */
const normalize = (d: Doc): Doc => (d.content?.length ? d : { type: "doc", content: [{ type: "paragraph" }] });

function editMath(editor: Editor | null, latex: string, pos: number, kind: "inline" | "block") {
  if (!editor) return;
  const next = window.prompt("Edit formula (LaTeX)", latex);
  if (next == null) return;
  const chain = editor.chain().setNodeSelection(pos);
  if (!next.trim()) chain.deleteSelection().run();
  else if (kind === "inline") chain.updateInlineMath({ latex: next }).run();
  else chain.updateBlockMath({ latex: next }).run();
}

function Toolbar({ editor, compact }: { editor: Editor; compact?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive("heading", { level: 1 }), h2: e.isActive("heading", { level: 2 }), h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"), italic: e.isActive("italic"), hl: e.isActive("highlight"),
      ul: e.isActive("bulletList"), ol: e.isActive("orderedList"), task: e.isActive("taskList"),
      quote: e.isActive("blockquote"), callout: e.isActive("callout"), code: e.isActive("codeBlock"), link: e.isActive("link"),
      table: e.isActive("table"),
    }),
  });
  const B = ({ on, label, title, run }: { on?: boolean; label: string; title: string; run: () => void }) => (
    <button type="button" title={title} aria-label={title} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={run}
      className={`h-8 min-w-8 shrink-0 rounded-md px-2 text-[13px] ${on ? "bg-muted text-fg" : "text-fg-2 hover:bg-muted hover:text-fg"}`}>{label}</button>
  );
  const c = () => editor.chain().focus();
  const addLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (!url.trim()) c().unsetLink().run();
    else if (/^(https?:|mailto:)/i.test(url.trim())) c().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const addMath = (block: boolean) => {
    const latex = window.prompt(block ? "Formula (LaTeX, display)" : "Formula (LaTeX)", "");
    if (!latex?.trim()) return;
    if (block) c().insertBlockMath({ latex }).run();
    else c().insertInlineMath({ latex }).run();
  };

  return (
    <div role="toolbar" aria-label="Formatting"
      className={`sticky top-0 z-20 -mx-2 mb-4 flex flex-nowrap items-center overflow-x-auto sm:flex-wrap gap-0.5 bg-bg/90 px-2 py-1.5 backdrop-blur ${compact ? "opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100" : ""}`}>
      <B on={s.h1} label="H1" title="Heading 1" run={() => c().toggleHeading({ level: 1 }).run()} />
      <B on={s.h2} label="H2" title="Heading 2" run={() => c().toggleHeading({ level: 2 }).run()} />
      <B on={s.h3} label="H3" title="Heading 3" run={() => c().toggleHeading({ level: 3 }).run()} />
      <span className="mx-1 h-4 w-px bg-border" />
      <B on={s.bold} label="B" title="Bold (Ctrl+B)" run={() => c().toggleBold().run()} />
      <B on={s.italic} label="I" title="Italic (Ctrl+I)" run={() => c().toggleItalic().run()} />
      <B on={s.hl} label="Mark" title="Highlight (Ctrl+Shift+H)" run={() => c().toggleHighlight().run()} />
      <B on={s.link} label="Link" title="Link" run={addLink} />
      <span className="mx-1 h-4 w-px bg-border" />
      <B on={s.ul} label="•" title="Bullet list" run={() => c().toggleBulletList().run()} />
      <B on={s.ol} label="1." title="Numbered list" run={() => c().toggleOrderedList().run()} />
      <B on={s.task} label="☐" title="Checklist" run={() => c().toggleTaskList().run()} />
      <B on={s.quote} label="❝" title="Quote" run={() => c().toggleBlockquote().run()} />
      <B on={s.callout} label="Callout" title="Callout (type !> )" run={() => c().toggleCallout().run()} />
      <B on={s.code} label="</>" title="Code block" run={() => c().toggleCodeBlock().run()} />
      <span className="mx-1 h-4 w-px bg-border" />
      <B label="∑" title="Inline formula" run={() => addMath(false)} />
      <B label="∑∑" title="Display formula" run={() => addMath(true)} />
      {s.table ? (
        <>
          <B label="+Row" title="Add row" run={() => c().addRowAfter().run()} />
          <B label="+Col" title="Add column" run={() => c().addColumnAfter().run()} />
          <B label="−Row" title="Delete row" run={() => c().deleteRow().run()} />
          <B label="−Col" title="Delete column" run={() => c().deleteColumn().run()} />
          <B label="×Table" title="Delete table" run={() => c().deleteTable().run()} />
        </>
      ) : (
        <B label="Table" title="Insert table" run={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
      )}
      <B label="Draw" title="Insert drawing (D)" run={() => c().insertSketch().run()} />
    </div>
  );
}
