import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { insertBlockFromSlash } from '../blocks/commands';
import { searchBlocks, type BlockDefinition } from '../blocks/registry';
import {
  SlashMenuList,
  type SlashMenuListHandle,
  type SlashMenuListProps,
} from './slash-menu-list';

export const slashMenuKey = new PluginKey('slashMenu');

type Props = SuggestionProps<BlockDefinition, BlockDefinition>;

/** Typing `/` opens a filterable menu of every block in the registry. */
export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<BlockDefinition, BlockDefinition>({
        editor: this.editor,
        pluginKey: slashMenuKey,
        char: '/',
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => searchBlocks(query),
        command: ({ editor, range, props }) => insertBlockFromSlash(editor, range, props),
        render: () => {
          let renderer: ReactRenderer<SlashMenuListHandle, SlashMenuListProps> | null = null;
          let element: HTMLDivElement | null = null;

          const place = (props: Props) => {
            const rect = props.clientRect?.();
            if (!element || !rect) return;
            void computePosition({ getBoundingClientRect: () => rect }, element, {
              placement: 'bottom-start',
              middleware: [offset(6), flip(), shift({ padding: 8 })],
            }).then(({ x, y }) => {
              if (element) Object.assign(element.style, { left: `${x}px`, top: `${y}px` });
            });
          };

          return {
            onStart(props: Props) {
              renderer = new ReactRenderer(SlashMenuList, {
                editor: props.editor,
                props: { items: props.items, command: props.command },
              });
              element = document.createElement('div');
              element.className = 'ws-floating';
              element.dataset.testid = 'slash-menu';
              element.append(renderer.element);
              document.body.append(element);
              place(props);
            },
            onUpdate(props: Props) {
              renderer?.updateProps({ items: props.items, command: props.command });
              place(props);
            },
            onKeyDown({ event }) {
              if (event.key === 'Escape') {
                element?.remove();
                return false;
              }
              return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit() {
              element?.remove();
              renderer?.destroy();
              element = null;
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
