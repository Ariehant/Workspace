import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import { Bookmark, Code2, Link } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { replaceCurrentBlock } from './blocks/commands';
import { toEmbedUrl } from './nodes/embeds';

export interface PastedUrl {
  url: string;
  from: number;
  to: number;
}

/** Replace the pasted link with a block: in place of its paragraph if that holds only the link. */
function convert(editor: Editor, { url, from, to }: PastedUrl, type: 'bookmark' | 'embed') {
  const { doc } = editor.state;
  if (doc.textBetween(from, to) !== url) return; // the text changed meanwhile
  const $from = doc.resolve(from);
  const block = { type, attrs: { url } };
  const chain = editor.chain().focus();
  if ($from.parent.textContent !== url) {
    // Other text around the link: remove the link and continue in a new empty block
    // below its paragraph (which shrank by the link's length).
    const afterParagraph = $from.after($from.depth) - (to - from);
    chain
      .deleteRange({ from, to })
      .insertContentAt(afterParagraph, { type: 'paragraph' })
      .setTextSelection(afterParagraph + 1);
  } else {
    chain.setTextSelection(from);
  }
  chain.command(replaceCurrentBlock(block)).run();
}

/** Small menu after pasting a link: keep it as a link, or make a bookmark or embed. */
export function PasteUrlMenu({
  editor,
  pasted,
  onClose,
}: {
  editor: Editor;
  pasted: PastedUrl;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const embeddable = toEmbedUrl(pasted.url) !== null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { left, bottom } = editor.view.coordsAtPos(pasted.to);
    void computePosition({ getBoundingClientRect: () => new DOMRect(left, bottom, 1, 1) }, el, {
      placement: 'bottom-start',
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  }, [editor, pasted.to]);

  // Any further edit, Escape or a click elsewhere keeps the plain link.
  useEffect(() => {
    let first = true;
    const onUpdate = () => {
      if (first) first = false;
      else onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    const onDown = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && onClose();
    editor.on('update', onUpdate);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      editor.off('update', onUpdate);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [editor, onClose]);

  const choose = (type: 'bookmark' | 'embed') => {
    onClose();
    convert(editor, pasted, type);
  };

  const item = 'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover';
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Paste as"
      data-testid="paste-url-menu"
      className="ws-floating w-52 rounded-lg bg-menu p-1 text-sm text-fg shadow-menu"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="px-2 py-1 text-xs text-muted">Paste as</div>
      <button type="button" role="menuitem" className={item} onClick={onClose}>
        <Link size={14} className="text-muted" /> URL
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => choose('bookmark')}>
        <Bookmark size={14} className="text-muted" /> Bookmark
      </button>
      {embeddable && (
        <button type="button" role="menuitem" className={item} onClick={() => choose('embed')}>
          <Code2 size={14} className="text-muted" /> Embed
        </button>
      )}
    </div>
  );
}
