import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { useLayoutEffect, useRef, useState } from 'react';

export interface MathTarget {
  node: PMNode;
  pos: number;
}

/** Popover for editing an equation's TeX source. */
export function MathEditor({
  editor,
  target,
  onClose,
}: {
  editor: Editor;
  target: MathTarget;
  onClose(): void;
}) {
  const block = target.node.type.name === 'blockMath';
  const [latex, setLatex] = useState((target.node.attrs.latex as string) ?? '');
  const ref = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    const anchor = editor.view.nodeDOM(target.pos) as HTMLElement | null;
    const el = ref.current;
    if (!anchor || !el) return;
    void computePosition(anchor, el, {
      placement: 'bottom-start',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  }, [editor, target.pos]);

  const save = () => {
    // Focus synchronously rather than with chain().focus(): TipTap's focus() runs a frame
    // later and then rewrites the DOM selection, undoing a key pressed in between.
    editor.view.focus();
    const chain = editor.chain();
    if (block && !latex.trim()) chain.deleteBlockMath({ pos: target.pos });
    else if (block) chain.updateBlockMath({ latex, pos: target.pos });
    else if (!latex.trim()) chain.deleteInlineMath({ pos: target.pos });
    else chain.updateInlineMath({ latex, pos: target.pos });
    chain.run();
    onClose();
  };

  return (
    <form
      ref={ref}
      className="ws-floating flex w-96 flex-col gap-2 rounded-lg bg-menu p-2 text-sm text-fg shadow-menu"
      data-testid="math-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <textarea
        autoFocus
        value={latex}
        onChange={(event) => setLatex(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            editor.view.focus();
            onClose();
          } else if (event.key === 'Enter' && (!block || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        rows={block ? 3 : 1}
        placeholder={block ? 'E = mc^2' : 'x^2'}
        aria-label="TeX equation"
        spellCheck={false}
        className="resize-none rounded border border-line bg-surface p-2 font-mono text-sm outline-none focus:border-accent"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{block ? 'Ctrl+Enter' : 'Enter'} to save</span>
        <button type="submit" className="h-7 rounded bg-accent px-3 text-sm text-accent-fg">
          Done
        </button>
      </div>
    </form>
  );
}
