import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { insertBlockFromSlash } from '../blocks/commands';
import { searchBlocks, type BlockDefinition } from '../blocks/registry';
import { floatingList } from '../suggestions/floating';
import { SlashMenuList } from './slash-menu-list';

export const slashMenuKey = new PluginKey('slashMenu');

/** Typing `/` opens a filterable menu of every block in the registry. */
export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<BlockDefinition, BlockDefinition>({
        editor: this.editor,
        pluginKey: slashMenuKey,
        char: '/',
        // Notion matches multi-word queries ("/2 col", "/link to page").
        allowSpaces: true,
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => searchBlocks(query),
        command: ({ editor, range, props }) => void insertBlockFromSlash(editor, range, props),
        render: floatingList<BlockDefinition>(SlashMenuList, {
          testId: 'slash-menu',
          // Like Notion, give up once the query clearly isn't a block name.
          shouldExit: (props) => props.items.length === 0 && /\s\S*\s$|.{24,}/.test(props.query),
          exit: (props) => exitSuggestion(props.editor.view, slashMenuKey),
        }),
      }),
    ];
  },
});
