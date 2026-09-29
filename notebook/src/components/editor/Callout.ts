import { mergeAttributes, Node, wrappingInputRule } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: { toggleCallout: () => ReturnType };
  }
}

/** A highlighted note block. Type "!> " at the start of a line to create one. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0],
  addCommands() {
    return { toggleCallout: () => ({ commands }) => commands.toggleWrap(this.name) };
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^!>\s$/, type: this.type })];
  },
});
