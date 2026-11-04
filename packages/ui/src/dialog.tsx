import * as RadixDialog from '@radix-ui/react-dialog';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from './cn';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogTitle = RadixDialog.Title;

/** What had the focus when a dialog opened, to find it again if it was drawn anew. */
interface Opener {
  element: HTMLElement;
  tag: string;
  label: string | null;
  text: string | null;
}

function describeOpener(element: Element | null): Opener | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  return {
    element,
    tag: element.tagName,
    label: element.getAttribute('aria-label'),
    text: element.textContent,
  };
}

/** The opener, or the control that replaced it (the same kind, name and text). */
function findOpener(opener: Opener): HTMLElement | null {
  if (opener.element.isConnected) return opener.element;
  return (
    [...document.querySelectorAll<HTMLElement>(opener.tag)].find(
      (el) => el.getAttribute('aria-label') === opener.label && el.textContent === opener.text,
    ) ?? null
  );
}

/** Centered modal with a dimmed backdrop. `title` is required for screen readers. */
export function DialogContent({
  title,
  hideTitle,
  className,
  children,
  ...props
}: ComponentProps<typeof RadixDialog.Content> & {
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  // Most dialogs open from a menu item, a shortcut or a button that isn't a DialogTrigger,
  // so Radix has nowhere to return the focus on close: back to what had it when it opened.
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : describeOpener(document.activeElement),
  );
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <RadixDialog.Content
        aria-describedby={undefined}
        className={cn(
          'fixed top-[15vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2',
          'rounded-xl bg-menu text-sm text-fg shadow-menu outline-none',
          className,
        )}
        {...props}
        onCloseAutoFocus={(event) => {
          props.onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // This runs a moment after closing: if something else has the focus by now (another
          // dialog opened straight away), leave it there.
          event.preventDefault();
          const active = document.activeElement;
          if (active && active !== document.body) return;
          (opener && findOpener(opener))?.focus();
        }}
      >
        <RadixDialog.Title className={hideTitle ? 'sr-only' : 'px-4 pt-4 text-base font-semibold'}>
          {title}
        </RadixDialog.Title>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
