import * as RadixPopover from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/** A popover is a dialog to assistive technology, so it needs a name (`aria-label`). */
export function PopoverContent({
  className,
  ...props
}: ComponentProps<typeof RadixPopover.Content> & { 'aria-label': string }) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={6}
        align="start"
        collisionPadding={8}
        className={cn(
          'z-50 rounded-lg bg-menu text-sm text-fg shadow-menu outline-none',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
