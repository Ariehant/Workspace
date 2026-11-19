import { Dialog, DialogContent } from '@workspace/ui';
import { createContext, useContext, type ReactNode } from 'react';

/** Set inside the Settings window: settings show as its sections, not dialogs of their own. */
export const SettingsEmbedded = createContext(false);

/**
 * A group of settings: a dialog of its own, or (inside the Settings window) a section of it,
 * with the same title and test id either way.
 */
export function SettingsShell({
  title,
  className,
  onClose,
  children,
  'data-testid': testId,
}: {
  title: string;
  /** The dialog's size (the window sizes its sections itself). */
  className?: string;
  onClose(): void;
  children: ReactNode;
  'data-testid'?: string;
}) {
  if (useContext(SettingsEmbedded)) {
    return (
      <section aria-labelledby={`${testId ?? title}-heading`} data-testid={testId}>
        <h2 id={`${testId ?? title}-heading`} className="px-4 pt-4 text-base font-semibold">
          {title}
        </h2>
        {children}
      </section>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={title} className={className} data-testid={testId}>
        {children}
      </DialogContent>
    </Dialog>
  );
}
