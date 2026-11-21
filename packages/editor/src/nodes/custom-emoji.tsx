import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useCallback, useSyncExternalStore } from 'react';
import { useEditorServices } from '../services';

/** A custom emoji in a page: `:name:`, shown as its image while the workspace has it. */
export interface CustomEmojiRef {
  name: string;
  fileId: string;
}

const NO_EMOJI: readonly CustomEmojiRef[] = [];
const none = () => () => {};

/** The workspace's custom emoji, kept current. */
export function useCustomEmoji(): readonly CustomEmojiRef[] {
  const services = useEditorServices();
  const source = services.customEmoji;
  const subscribe = useCallback(
    (listener: () => void) => (source ? source.subscribe(listener) : none()),
    [source],
  );
  // A string snapshot, stable while nothing changes.
  const key = useSyncExternalStore(subscribe, () => JSON.stringify(source?.list() ?? NO_EMOJI));
  return JSON.parse(key) as CustomEmojiRef[];
}

function CustomEmojiView({ node }: ReactNodeViewProps) {
  const services = useEditorServices();
  const name = String(node.attrs.name ?? '');
  const emoji = useCustomEmoji().find((e) => e.name === name);
  return (
    <NodeViewWrapper as="span" data-type="custom-emoji" data-name={name}>
      {emoji ? (
        <img
          className="ws-emoji"
          src={services.fileUrl(emoji.fileId)}
          alt={`:${name}:`}
          title={`:${name}:`}
          draggable={false}
        />
      ) : (
        // Removed from the workspace: its name, as typed.
        <span className="text-muted">:{name}:</span>
      )}
    </NodeViewWrapper>
  );
}

export const CustomEmoji = Node.create({
  name: 'customEmoji',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-name') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-name': String(attrs.name) }),
      },
      fileId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-file'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.fileId ? { 'data-file': String(attrs.fileId) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: '[data-type="custom-emoji"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-type': 'custom-emoji' }),
      `:${String(node.attrs.name)}:`,
    ];
  },

  renderText({ node }) {
    return `:${String(node.attrs.name)}:`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CustomEmojiView, { as: 'span' });
  },
});
