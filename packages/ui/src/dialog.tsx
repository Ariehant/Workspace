import * as RadixDialog from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogTitle = RadixDialog.Title;

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
      >
        <RadixDialog.Title className={hideTitle ? 'sr-only' : 'px-4 pt-4 text-base font-semibold'}>
          {title}
        </RadixDialog.Title>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
