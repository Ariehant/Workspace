import { Dialog, DialogContent } from '@workspace/ui';

/** Every keyboard shortcut, by where it works (also in docs/desktop.md). */
export const SHORTCUTS: { section: string; keys: [keys: string, does: string][] }[] = [
  {
    section: 'Anywhere',
    keys: [
      ['Ctrl+K or Ctrl+P', 'Quick find (Ctrl+Enter opens the result in a new window)'],
      ['Ctrl+N', 'New page'],
      ['Ctrl+T / Ctrl+W', 'New tab / close tab'],
      ['Ctrl+Tab', 'Next tab'],
      ['Ctrl+Shift+N', 'New window (desktop)'],
      ['Alt+← / Alt+→, or Ctrl+[ / Ctrl+]', 'Back / forward'],
      ['Ctrl+Shift+U', 'Go to the parent page'],
      ['Ctrl+\\', 'Show or hide the sidebar'],
      ['Ctrl+Shift+L', 'Dark or light mode'],
      ['Ctrl+= / Ctrl+- / Ctrl+0', 'Zoom in / out / actual size (desktop)'],
      ['Ctrl+F', 'Find and replace in the page'],
      ['Ctrl+?', 'These shortcuts'],
    ],
  },
  {
    section: 'Writing',
    keys: [
      ['/', 'Insert a block, or run a command (/red, /turn into h2, /duplicate…)'],
      ['@', 'Mention a page, a person or a date'],
      [':', 'Emoji'],
      ['Ctrl+B, Ctrl+I, Ctrl+U', 'Bold, italic, underline'],
      ['Ctrl+Shift+S', 'Strikethrough'],
      ['Ctrl+E', 'Inline code'],
      ['Ctrl+Shift+E', 'Inline equation'],
      ['Ctrl+Shift+H', 'The colour used last'],
      ['Ctrl+Shift+M', 'Comment on the selection'],
      ['Tab / Shift+Tab', 'Indent / outdent'],
    ],
  },
  {
    section: 'Blocks',
    keys: [
      ['Ctrl+Shift+↑ / ↓', 'Move the block (or the selected blocks) up / down'],
      ['Ctrl+D', 'Duplicate the block (or the selected blocks)'],
      ['Shift+↑ / ↓', 'Select blocks'],
      ['Ctrl+Enter', 'Check a to-do, or open or close a toggle'],
      ['Ctrl+Alt+0', 'Turn into text'],
      ['Ctrl+Alt+1 / 2 / 3', 'Turn into a heading'],
      ['Ctrl+Alt+4', 'Turn into a to-do'],
      ['Ctrl+Alt+5 / 6', 'Turn into a bulleted / numbered list'],
      ['Ctrl+Alt+7', 'Turn into a toggle'],
      ['Ctrl+Alt+8', 'Turn into code'],
      ['Ctrl+Alt+9', 'New sub-page here'],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Keyboard shortcuts"
        data-testid="shortcuts-dialog"
        className="w-[min(640px,calc(100vw-32px))]"
      >
        {/* Focusable, so the list scrolls with the keyboard too. */}
        <div
          tabIndex={0}
          role="region"
          aria-label="Shortcuts"
          className="max-h-[70vh] overflow-y-auto p-4 pt-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {SHORTCUTS.map(({ section, keys }) => (
            <section key={section} className="mb-3">
              <h3 className="mb-1 text-xs font-medium text-muted">{section}</h3>
              <dl className="grid grid-cols-[minmax(0,14rem)_1fr] gap-x-4 gap-y-1">
                {keys.map(([combo, does]) => (
                  <div key={combo} className="contents">
                    <dt>
                      <kbd className="font-mono text-xs">{combo}</kbd>
                    </dt>
                    <dd className="text-muted">{does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
