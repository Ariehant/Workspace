import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { cn } from '@workspace/ui';
import {
  Bold,
  ChevronDown,
  Code,
  Italic,
  Link2,
  MessageSquare,
  Radical,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { CONVERTIBLE_BLOCKS, activeBlock } from './blocks/registry';
import { ColorPanel, ColorSwatch } from './color-menu';
import { anchorFor, type EditorComments } from './comments';
import type { ColorValue } from './nodes/colors';
import { insertInlineEquation } from './nodes/math';

const MARKS = [
  {
    mark: 'bold',
    label: 'Bold (Ctrl+B)',
    icon: Bold,
    toggle: (e: Editor) => e.chain().focus().toggleBold(),
  },
  {
    mark: 'italic',
    label: 'Italic (Ctrl+I)',
    icon: Italic,
    toggle: (e: Editor) => e.chain().focus().toggleItalic(),
  },
  {
    mark: 'underline',
    label: 'Underline (Ctrl+U)',
    icon: Underline,
    toggle: (e: Editor) => e.chain().focus().toggleUnderline(),
  },
  {
    mark: 'strike',
    label: 'Strikethrough (Ctrl+Shift+S)',
    icon: Strikethrough,
    toggle: (e: Editor) => e.chain().focus().toggleStrike(),
  },
  {
    mark: 'code',
    label: 'Inline code (Ctrl+E)',
    icon: Code,
    toggle: (e: Editor) => e.chain().focus().toggleCode(),
  },
] as const;

type ShouldShow = NonNullable<React.ComponentProps<typeof BubbleMenu>['shouldShow']>;

/** Show for a non-empty text selection outside code blocks. */
const showForTextSelection: ShouldShow = ({ editor, from, to }) =>
  editor.isEditable &&
  from !== to &&
  !editor.isActive('codeBlock') &&
  editor.state.doc.textBetween(from, to).length > 0;

/** Keep the editor focused (and its selection visible) while clicking toolbar buttons. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

function ToolbarButton(props: {
  label: string;
  active?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      onMouseDown={keepFocus}
      onClick={props.onClick}
      className={cn(
        'flex h-7 min-w-7 items-center justify-center gap-1 rounded px-1.5 text-sm hover:bg-hover',
        props.active ? 'text-accent' : 'text-fg',
      )}
    >
      {props.children}
    </button>
  );
}

/** Formatting toolbar shown over a text selection. */
export function SelectionToolbar({
  editor,
  comments,
}: {
  editor: Editor;
  /** The page's comments: a Comment button (absent where there are none). */
  comments?: EditorComments | null;
}) {
  const [panel, setPanel] = useState<'none' | 'turnInto' | 'link' | 'color'>('none');
  const [href, setHref] = useState('');

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      marks: Object.fromEntries(MARKS.map(({ mark }) => [mark, e.isActive(mark)])),
      link: e.getAttributes('link').href as string | undefined,
      color: (e.getAttributes('color').color as string | undefined) ?? null,
      block: activeBlock(e)?.title ?? 'Text',
      // Suggesting: formatting isn't a suggestion, so only Comment is offered.
      suggesting: comments?.suggesting() ?? false,
    }),
  });

  // BubbleMenu re-creates its plugin when these change, so keep them stable.
  const options = useMemo(
    () => ({ placement: 'top-start' as const, offset: 8, onHide: () => setPanel('none') }),
    [],
  );

  const openLink = () => {
    setHref(state.link ?? '');
    setPanel(panel === 'link' ? 'none' : 'link');
  };

  const applyLink = () => {
    // Focus synchronously rather than with chain().focus(): TipTap's focus() runs a frame
    // later and then rewrites the DOM selection, undoing a key pressed in between.
    editor.view.focus();
    const chain = editor.chain().extendMarkRange('link');
    const url = href.trim();
    if (!url) chain.unsetLink().run();
    else chain.setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` }).run();
    setPanel('none');
  };

  return (
    <BubbleMenu
      editor={editor}
      options={options}
      shouldShow={showForTextSelection}
      // TipTap debounces showing (250 ms) but hides at once; mixing the two can leave
      // the toolbar out of step with the selection. Update right away instead.
      updateDelay={0}
      className="ws-floating"
      data-testid="selection-toolbar"
    >
      <div className="flex flex-col rounded-lg bg-menu text-fg shadow-menu">
        <div className="flex items-center gap-0.5 p-1">
          {comments && (
            <>
              <ToolbarButton
                label="Comment (Ctrl+Shift+M)"
                onClick={() => {
                  const { from, to } = editor.state.selection;
                  const anchor = anchorFor(editor.state, from, to);
                  if (!anchor) return;
                  // The highlight shows what's commented on; the toolbar goes.
                  editor.commands.setTextSelection(to);
                  comments.comment(anchor);
                }}
              >
                <MessageSquare size={15} />
                <span>Comment</span>
              </ToolbarButton>
              {!state.suggesting && <span className="mx-0.5 h-5 w-px bg-line" />}
            </>
          )}
          {!state.suggesting && (
            <>
              <ToolbarButton
                label="Turn into"
                onClick={() => setPanel(panel === 'turnInto' ? 'none' : 'turnInto')}
              >
                <span className="max-w-28 truncate">{state.block}</span>
                <ChevronDown size={12} />
              </ToolbarButton>
              <span className="mx-0.5 h-5 w-px bg-line" />
              <ToolbarButton label="Link" active={Boolean(state.link)} onClick={openLink}>
                <Link2 size={16} />
              </ToolbarButton>
              <span className="mx-0.5 h-5 w-px bg-line" />
              <ToolbarButton
                label="Text color"
                active={panel === 'color'}
                onClick={() => setPanel(panel === 'color' ? 'none' : 'color')}
              >
                <ColorSwatch value={(state.color as ColorValue | null) ?? null} />
                <ChevronDown size={12} />
              </ToolbarButton>
              <ToolbarButton label="Create equation" onClick={() => insertInlineEquation(editor)}>
                <Radical size={16} />
              </ToolbarButton>
              {MARKS.map(({ mark, label, icon: Icon, toggle }) => (
                <ToolbarButton
                  key={mark}
                  label={label}
                  active={state.marks[mark]}
                  onClick={() => toggle(editor).run()}
                >
                  <Icon size={16} />
                </ToolbarButton>
              ))}
            </>
          )}
        </div>

        {panel === 'turnInto' && (
          <div role="menu" aria-label="Turn into" className="border-t border-line p-1">
            {CONVERTIBLE_BLOCKS.map((block) => (
              <button
                key={block.id}
                type="button"
                role="menuitem"
                onMouseDown={keepFocus}
                onClick={() => {
                  block.apply(editor.chain().focus(), {}).run();
                  setPanel('none');
                }}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover"
              >
                <block.icon size={16} className="text-muted" />
                <span className="flex-1">{block.title}</span>
                {block.isActive(editor) && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        )}

        {panel === 'color' && (
          <ColorPanel
            current={state.color}
            onPick={(value) => {
              editor.chain().focus().setTextColor(value).run();
              setPanel('none');
            }}
          />
        )}

        {panel === 'link' && (
          <form
            className="flex gap-1 border-t border-line p-1"
            onSubmit={(event) => {
              event.preventDefault();
              applyLink();
            }}
          >
            <input
              autoFocus
              value={href}
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                editor.view.focus();
                setPanel('none');
              }}
              placeholder="Paste link"
              aria-label="Link URL"
              className="h-7 w-64 rounded border border-line bg-surface px-2 text-sm outline-none focus:border-accent"
            />
            <button type="submit" className="h-7 rounded bg-accent px-2 text-sm text-accent-fg">
              Apply
            </button>
          </form>
        )}
      </div>
    </BubbleMenu>
  );
}
