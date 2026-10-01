import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { isUrl } from './embeds';
import { insertFiles } from './media';

/**
 * - Pasting or dropping files uploads them and inserts image/video/audio/PDF/file blocks.
 * - Pasting a bare URL inserts it as a link and offers to turn it into a bookmark or
 *   embed (like Notion); pasting a URL over selected text links that text.
 */
export const PasteAndDrop = Extension.create({
  name: 'pasteAndDrop',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('pasteAndDrop'),
        props: {
          handlePaste(view, event) {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length > 0) {
              void insertFiles(editor, files);
              return true;
            }

            const text = event.clipboardData?.getData('text/plain').trim() ?? '';
            if (!isUrl(text) || editor.isActive('codeBlock')) return false;
            const { from, to, empty } = view.state.selection;
            if (!empty) {
              editor.chain().setLink({ href: text }).run();
              return true;
            }
            const link = view.state.schema.marks.link!.create({ href: text });
            view.dispatch(
              view.state.tr.replaceWith(from, to, view.state.schema.text(text, [link])),
            );
            editor.storage.uiBridge.ref.current.pastedUrl?.(text, from, from + text.length);
            return true;
          },

          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length === 0) return false;
            event.preventDefault();
            const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const $pos = view.state.doc.resolve(hit?.pos ?? view.state.selection.from);
            // Insert after the top-level block under the pointer.
            void insertFiles(editor, files, $pos.depth >= 1 ? $pos.after(1) : $pos.pos);
            return true;
          },
        },
      }),
    ];
  },
});
