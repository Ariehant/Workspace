import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { Menu, MenuContent, MenuTrigger } from '@workspace/ui';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block(s) in a callout. */
      setCallout: () => ReturnType;
    };
  }
}

const ICONS = [
  '💡',
  '📌',
  '⚠️',
  '❗',
  '✅',
  '❌',
  'ℹ️',
  '🔥',
  '🚀',
  '📝',
  '🧪',
  '🤖',
  '⚙️',
  '🔧',
  '📎',
  '🎯',
];

function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const icon = node.attrs.icon as string;
  return (
    <NodeViewWrapper className="ws-callout" data-color={node.attrs.color}>
      <Menu modal={false}>
        <MenuTrigger asChild>
          <button
            type="button"
            contentEditable={false}
            disabled={!editor.isEditable}
            aria-label="Change callout icon"
            className="ws-callout-icon"
          >
            {icon}
          </button>
        </MenuTrigger>
        <MenuContent aria-label="Callout icon" className="grid min-w-0 grid-cols-8 gap-0.5">
          {ICONS.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-label={choice}
              onClick={() => updateAttributes({ icon: choice })}
              className="flex size-8 items-center justify-center rounded text-lg hover:bg-hover"
            >
              {choice}
            </button>
          ))}
        </MenuContent>
      </Menu>
      <NodeViewContent className="ws-callout-content" />
    </NodeViewWrapper>
  );
}

/** Callout: a highlighted box with an icon that can hold any blocks. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      icon: {
        default: '💡',
        parseHTML: (el) => el.getAttribute('data-icon') ?? '💡',
        renderHTML: (attrs) => ({ 'data-icon': attrs.icon }),
      },
      // A palette value (see colors.ts); callouts default to a gray background.
      color: {
        default: 'gray_background',
        parseHTML: (el) => el.getAttribute('data-color') ?? 'gray_background',
        renderHTML: (attrs) => ({ 'data-color': attrs.color }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },

  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
});
