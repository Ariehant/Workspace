import { Node as TiptapNode, type JSONContent } from '@tiptap/core';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { cn } from '@workspace/ui';
import { Bold, Code, Italic, Link as LinkIcon, Strikethrough, Underline } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { COLOR_LABELS, COLOR_NAMES, TextColor, isColorValue } from './nodes/colors';

/** A run of formatted text, as database text properties keep it. */
export interface RichRun {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  code?: true;
  color?: string;
  link?: string;
}

const MARKS = ['bold', 'italic', 'underline', 'strike', 'code'] as const;

/** Runs as an editor document: one paragraph, line breaks as hard breaks. */
export function runsToDoc(runs: readonly RichRun[]): JSONContent {
  const content: JSONContent[] = [];
  for (const run of runs) {
    const marks = [
      ...MARKS.filter((m) => run[m]).map((type) => ({ type })),
      ...(run.color && isColorValue(run.color)
        ? [{ type: 'color', attrs: { color: run.color } }]
        : []),
      ...(run.link ? [{ type: 'link', attrs: { href: run.link } }] : []),
    ];
    run.text.split('\n').forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line, ...(marks.length ? { marks } : {}) });
    });
  }
  return { type: 'doc', content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }] };
}

/** The editor's document as runs. */
export function docToRuns(doc: JSONContent): RichRun[] {
  const runs: RichRun[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'hardBreak') {
      runs.push({ text: '\n' });
      return;
    }
    if (node.type === 'text' && node.text) {
      const run: RichRun = { text: node.text };
      for (const mark of node.marks ?? []) {
        if ((MARKS as readonly string[]).includes(mark.type))
          run[mark.type as (typeof MARKS)[number]] = true;
        else if (mark.type === 'color' && isColorValue(mark.attrs?.color))
          run.color = mark.attrs.color;
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string')
          run.link = mark.attrs.href;
      }
      runs.push(run);
      return;
    }
    // Paragraphs after the first start on a new line.
    node.content?.forEach((child, i) => {
      if (node.type === 'doc' && i > 0) runs.push({ text: '\n' });
      walk(child);
    });
  };
  walk(doc);
  return runs;
}

const LINK = /^(https?:\/\/|mailto:|workspace:\/\/)/i;

/** Formatted text, drawn with the page's styles. */
export function RichText({ runs, className }: { runs: readonly RichRun[]; className?: string }) {
  return (
    <span className={cn('ws-rich', className)} data-testid="rich-text">
      {runs.map((run, i) => {
        let node: ReactNode = run.text.split('\n').map((line, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {line}
          </Fragment>
        ));
        if (run.code) node = <code>{node}</code>;
        if (run.bold) node = <strong>{node}</strong>;
        if (run.italic) node = <em>{node}</em>;
        if (run.underline) node = <u>{node}</u>;
        if (run.strike) node = <s>{node}</s>;
        if (run.color && isColorValue(run.color)) node = <span data-color={run.color}>{node}</span>;
        if (run.link && LINK.test(run.link)) {
          node = (
            <a
              href={run.link}
              target="_blank"
              rel="noopener noreferrer"
              // A link in a cell opens; the click doesn't also start editing.
              onClick={(e) => e.stopPropagation()}
            >
              {node}
            </a>
          );
        }
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </span>
  );
}

/** One paragraph; Shift+Enter breaks a line when `multiline`. */
const OneParagraph = TiptapNode.create({ name: 'doc', topNode: true, content: 'paragraph' });

export type RichTextExit = 'down' | 'right' | 'left' | null;

/**
 * Editing formatted text in place: Ctrl+B, I, U, Shift+S (strikethrough), E (code) and K
 * (link), or the toolbar, which also colours. Enter, Tab and Escape finish (and say where to
 * go next); leaving the field finishes too.
 */
export function RichTextInput({
  runs,
  label,
  multiline = true,
  initialText,
  onDone,
  className,
}: {
  runs: readonly RichRun[];
  label: string;
  multiline?: boolean;
  /** Text typed to start editing: it replaces the value. */
  initialText?: string;
  onDone(runs: RichRun[], exit: RichTextExit): void;
  className?: string;
}) {
  const done = useRef(false);
  const [linking, setLinking] = useState<string | null>(null);
  const finish = (editor: Editor, exit: RichTextExit) => {
    if (done.current) return;
    done.current = true;
    onDone(docToRuns(editor.getJSON()), exit);
  };
  // The key handlers below run outside React: they reach the editor through this, set as it
  // mounts (TipTap's onCreate comes from a timer, which the browser runs after queued keys).
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    immediatelyRender: true,
    extensions: [
      StarterKit.configure({
        document: false,
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        codeBlock: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
      }),
      OneParagraph,
      TextColor,
    ],
    content: initialText !== undefined ? runsToDoc([{ text: initialText }]) : runsToDoc(runs),
    editorProps: {
      attributes: {
        'aria-label': label,
        'aria-multiline': String(multiline),
        role: 'textbox',
        'data-testid': 'cell-editor',
      },
      handleKeyDown: (view, event) => {
        event.stopPropagation();
        const ed = editorRef.current;
        if (!ed || event.isComposing) return false;
        if (event.key === 'Enter' && multiline && event.shiftKey) {
          ed.commands.setHardBreak();
          return true;
        }
        if (event.key === 'Enter') {
          finish(ed, 'down');
          return true;
        }
        if (event.key === 'Escape') {
          finish(ed, null);
          return true;
        }
        if (event.key === 'Tab') {
          finish(ed, event.shiftKey ? 'left' : 'right');
          return true;
        }
        // Ctrl+K and Ctrl+E act on the selection: read it from the page first (the browser
        // tells ProseMirror about a Shift+Arrow a moment later, which can be after this key).
        if ((event.ctrlKey || event.metaKey) && ['k', 'e'].includes(event.key.toLowerCase())) {
          (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          setLinking((ed.getAttributes('link').href as string | undefined) ?? '');
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
          ed.commands.toggleCode();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        // Pasted text stays on one line where lines can't break.
        if (multiline) return false;
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        editorRef.current?.commands.insertContent(text.replace(/\s*\n\s*/g, ' '));
        return true;
      },
    },
  });
  const wrapper = useRef<HTMLDivElement>(null);
  // Focus as soon as it's on screen, before the next key arrives (typing on a selected cell
  // starts editing, and the rest of the word follows straight away).
  useLayoutEffect(() => {
    editorRef.current = editor;
    editor.view.focus();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  }, [editor]);

  const keep = (e: React.MouseEvent) => e.preventDefault();
  const tool = (name: string, active: boolean, icon: ReactNode, run: () => void) => (
    <button
      type="button"
      aria-label={name}
      title={name}
      aria-pressed={active}
      onMouseDown={keep}
      onClick={run}
      className={cn(
        'flex size-6 items-center justify-center rounded text-muted hover:bg-hover',
        active && 'bg-hover text-fg',
      )}
    >
      {icon}
    </button>
  );

  const applyLink = (href: string) => {
    const chain = editor.chain().extendMarkRange('link');
    if (href.trim()) chain.setLink({ href: href.trim() }).run();
    else chain.unsetLink().run();
    // Back to the text now (TipTap's focus waits a frame, and the link box goes away first).
    editor.view.focus();
    setLinking(null);
  };

  return (
    <div
      ref={wrapper}
      className={cn('ws-rich ws-rich-input bg-menu', className)}
      // Clicks here (the toolbar, the link box's button, which Enter clicks) stay here: the
      // cell or card around it would take them as a click on itself.
      onClick={(e) => e.stopPropagation()}
      // Leaving the field (not for its toolbar or link box) finishes.
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !wrapper.current?.contains(next)) finish(editor, null);
      }}
    >
      <EditorContent editor={editor} className="px-2 py-1.5 text-sm leading-5 text-fg" />
      <div
        className="flex items-center gap-0.5 border-t border-line px-1 py-0.5"
        role="toolbar"
        aria-label="Text formatting"
      >
        {tool('Bold', editor.isActive('bold'), <Bold size={14} />, () =>
          editor.chain().focus().toggleBold().run(),
        )}
        {tool('Italic', editor.isActive('italic'), <Italic size={14} />, () =>
          editor.chain().focus().toggleItalic().run(),
        )}
        {tool('Underline', editor.isActive('underline'), <Underline size={14} />, () =>
          editor.chain().focus().toggleUnderline().run(),
        )}
        {tool('Strikethrough', editor.isActive('strike'), <Strikethrough size={14} />, () =>
          editor.chain().focus().toggleStrike().run(),
        )}
        {tool('Code', editor.isActive('code'), <Code size={14} />, () =>
          editor.chain().focus().toggleCode().run(),
        )}
        {tool('Link', editor.isActive('link'), <LinkIcon size={14} />, () =>
          setLinking((editor.getAttributes('link').href as string | undefined) ?? ''),
        )}
        <select
          aria-label="Color"
          className="ml-1 h-6 rounded bg-transparent text-xs text-muted hover:bg-hover"
          value={(editor.getAttributes('color').color as string | undefined) ?? ''}
          onChange={(e) => {
            editor
              .chain()
              .focus()
              .setTextColor(isColorValue(e.target.value) ? e.target.value : null)
              .run();
          }}
        >
          <option value="">Default color</option>
          {COLOR_NAMES.map((name) => (
            <option key={name} value={name}>
              {COLOR_LABELS[name]} text
            </option>
          ))}
          {COLOR_NAMES.map((name) => (
            <option key={`${name}_background`} value={`${name}_background`}>
              {COLOR_LABELS[name]} background
            </option>
          ))}
        </select>
      </div>
      {linking !== null && (
        <form
          className="flex items-center gap-1 border-t border-line px-1 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink(linking);
          }}
        >
          <input
            autoFocus
            aria-label="Link address"
            placeholder="Paste a link"
            value={linking}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                editor.view.focus();
                setLinking(null);
              }
            }}
            className="h-6 flex-1 rounded border border-line bg-bg px-1.5 text-xs outline-none"
          />
          <button type="submit" className="h-6 rounded px-2 text-xs hover:bg-hover">
            {linking.trim() ? 'Link' : 'Remove'}
          </button>
        </form>
      )}
    </div>
  );
}
