import { Extension, type Editor } from '@tiptap/core';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import NodeRange from '@tiptap/extension-node-range';
import UniqueID from '@tiptap/extension-unique-id';
import { Placeholder } from '@tiptap/extensions';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { PAGE_CONTENT_FIELD } from '@workspace/core';
import type * as Y from 'yjs';
import { SlashCommand } from './slash-menu/slash-command';

/** Node types that are blocks and get a stable `id` attribute. */
export const BLOCK_NODE_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
];

/** Ctrl/Cmd+click opens a link (plain clicks just place the cursor while editing). */
const OpenLinkOnModClick = Extension.create({
  name: 'openLinkOnModClick',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick(_view, _pos, event) {
            if (!(event.ctrlKey || event.metaKey)) return false;
            const link = (event.target as HTMLElement | null)?.closest('a[href]');
            if (!link) return false;
            window.open(link.getAttribute('href')!, '_blank', 'noopener');
            return true;
          },
        },
      }),
    ];
  },
});

function placeholderFor({
  editor,
  node,
  pos,
}: {
  editor: Editor;
  node: PMNode;
  pos: number;
}): string {
  if (node.type.name === 'heading') return `Heading ${node.attrs.level as number}`;
  const parent = editor.state.doc.resolve(pos).parent.type.name;
  if (parent === 'listItem') return 'List';
  if (parent === 'blockquote') return 'Empty quote';
  return "Write, or press '/' for commands…";
}

export function pageExtensions(doc: Y.Doc) {
  return [
    StarterKit.configure({
      undoRedo: false, // Yjs provides per-user undo through Collaboration.
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
      dropcursor: { color: 'var(--ws-accent)', width: 3 },
    }),
    Placeholder.configure({ placeholder: placeholderFor, includeChildren: true }),
    UniqueID.configure({
      types: BLOCK_NODE_TYPES,
      // Remote changes already carry ids; only assign ids to local edits.
      filterTransaction: (transaction) => !isChangeOrigin(transaction),
    }),
    Collaboration.configure({ document: doc, field: PAGE_CONTENT_FIELD }),
    NodeRange,
    SlashCommand,
    OpenLinkOnModClick,
  ];
}
