import { DragHandle } from '@tiptap/extension-drag-handle-react';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '@workspace/ui';
import { Copy, GripVertical, Link, Plus, Repeat2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  convertBlockAt,
  deleteBlockAt,
  duplicateBlockAt,
  insertBelowWithSlash,
} from './blocks/commands';
import { CONVERTIBLE_BLOCKS } from './blocks/registry';

/**
 * Must keep its identity across renders: DragHandle re-registers its plugin when this
 * object changes, and re-registering any plugin makes the Yjs binding re-render the
 * document from Yjs, which can undo an edit that hasn't been synced yet.
 */
const POSITION = { placement: 'left-start', strategy: 'absolute' } as const;

interface Target {
  node: PMNode;
  pos: number;
}

export interface BlockHandleProps {
  editor: Editor;
  /** Used to build "Copy link to block" URLs. */
  pageId: string;
}

/**
 * The `+` and `⋮⋮` controls left of the hovered block. Dragging `⋮⋮` moves the
 * block; clicking it opens the block menu.
 */
export function BlockHandle({ editor, pageId }: BlockHandleProps) {
  const target = useRef<Target | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const setOpen = (open: boolean) => {
    setMenuOpen(open);
    // Keep the handle on this block while its menu is open. (The React DragHandle
    // registers only the plugin, which reads this meta; the lock*/unlock* commands
    // belong to the separate DragHandle extension.)
    editor.commands.setMeta('lockDragHandle', open);
  };

  /** Run a menu action on the block the menu was opened for. */
  function act(fn: (t: Target) => void) {
    const current = target.current;
    if (current) fn(current);
    setOpen(false);
  }

  return (
    <DragHandle
      editor={editor}
      onNodeChange={({ node, pos }) => {
        if (!menuOpen) target.current = node ? { node, pos } : null;
      }}
      computePositionConfig={POSITION}
    >
      <div className="ws-block-handle flex items-center pr-1 text-faint" data-testid="block-handle">
        <button
          type="button"
          aria-label="Add block below"
          title="Click to add below"
          className="flex size-6 items-center justify-center rounded hover:bg-hover hover:text-muted"
          onClick={() =>
            target.current && insertBelowWithSlash(editor, target.current.pos, target.current.node)
          }
        >
          <Plus size={16} />
        </button>
        <Menu open={menuOpen} onOpenChange={setOpen} modal={false}>
          {/* Radix opens menus on pointerdown, which would fight with dragging, so the
              trigger is a passive anchor and the grip opens the menu on click. */}
          <MenuTrigger asChild>
            <span className="pointer-events-none absolute right-1 size-6" aria-hidden />
          </MenuTrigger>
          <button
            type="button"
            aria-label="Drag to move, click to open menu"
            title="Drag to move · Click to open menu"
            className="flex h-6 w-5 cursor-grab items-center justify-center rounded hover:bg-hover hover:text-muted"
            onClick={() => setOpen(true)}
          >
            <GripVertical size={16} />
          </button>
          <MenuContent
            side="left"
            align="start"
            aria-label="Block actions"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <MenuSub>
              <MenuSubTrigger icon={<Repeat2 size={14} />}>Turn into</MenuSubTrigger>
              <MenuSubContent>
                {CONVERTIBLE_BLOCKS.map((block) => (
                  <MenuItem
                    key={block.id}
                    icon={<block.icon size={14} />}
                    onSelect={() => act((t) => convertBlockAt(editor, t.pos, block))}
                  >
                    {block.title}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
            <MenuItem
              icon={<Copy size={14} />}
              onSelect={() => act((t) => duplicateBlockAt(editor, t.pos, t.node))}
            >
              Duplicate
            </MenuItem>
            <MenuItem
              icon={<Link size={14} />}
              onSelect={() =>
                act((t) => {
                  const id = t.node.attrs.id as string | undefined;
                  void navigator.clipboard.writeText(
                    `workspace://page/${pageId}${id ? `#${id}` : ''}`,
                  );
                })
              }
            >
              Copy link to block
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={14} />}
              danger
              onSelect={() => act((t) => deleteBlockAt(editor, t.pos, t.node))}
            >
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </DragHandle>
  );
}
