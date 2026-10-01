import Blockquote from '@tiptap/extension-blockquote';
import { wrappingInputRule } from '@tiptap/core';

/** Quote block. Started with `"` + space (Notion's shortcut); `>` makes a toggle. */
export const Quote = Blockquote.extend({
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*["“”]\s$/, type: this.type })];
  },
});
