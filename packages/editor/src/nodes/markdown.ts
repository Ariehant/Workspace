import { Extension } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const MARKDOWN_HINTS =
  /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|- \[[ x]\]\s|\|.+\||(-{3,}|\*{3,})$)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/m;

/** Does this plain text look like Markdown worth converting into blocks? */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINTS.test(text);
}

/**
 * Clipboard HTML that already carries structure (headings, lists, links...) is
 * pasted as HTML. HTML that is only styled lines, like VS Code's, is not.
 */
export function isStructuredHtml(html: string): boolean {
  return /<(h[1-6]|ul|ol|li|strong|b|em|i|a\s|table|pre|code|blockquote|p)\b/i.test(html);
}

/**
 * - Paste Markdown (e.g. from a README in VS Code) as real blocks.
 * - Copy puts Markdown in the plain-text clipboard, next to the rich HTML.
 */
export const MarkdownClipboard = Extension.create({
  name: 'markdownClipboard',
  addExtensions() {
    return [Markdown];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('markdownClipboard'),
        props: {
          handlePaste(_view, event) {
            const data = event.clipboardData;
            if (!data || data.files.length > 0 || editor.isActive('codeBlock')) return false;
            const text = data.getData('text/plain');
            const html = data.getData('text/html');
            if (!text || !looksLikeMarkdown(text) || (html && isStructuredHtml(html))) return false;
            return editor.commands.insertContent(text, { contentType: 'markdown' });
          },
          clipboardTextSerializer(slice) {
            try {
              return (
                editor.markdown?.serialize({ type: 'doc', content: slice.content.toJSON() }) ?? ''
              );
            } catch {
              return slice.content.textBetween(0, slice.content.size, '\n\n');
            }
          },
        },
      }),
    ];
  },
});
