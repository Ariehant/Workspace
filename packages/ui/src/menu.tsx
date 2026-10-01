import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ className, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={4}
        align="start"
        className={cn(
          'z-50 min-w-48 rounded-lg bg-menu p-1 text-sm text-fg shadow-menu',
          className,
        )}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof DropdownMenu.Item> {
  icon?: ReactNode;
  danger?: boolean;
}

export function MenuItem({ icon, danger, className, children, ...props }: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={cn(
        'flex h-7 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none',
        'data-[highlighted]:bg-hover',
        danger && 'data-[highlighted]:text-danger',
        className,
      )}
      {...props}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem
      className={cn(
        'flex h-7 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none',
        'data-[highlighted]:bg-hover',
        className,
      )}
      {...props}
    >
      <span className="flex size-4 items-center justify-center">
        <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
      </span>
      {children}
    </DropdownMenu.RadioItem>
  );
}

export const MenuSub = DropdownMenu.Sub;

export function MenuSubTrigger({
  icon,
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.SubTrigger> & { icon?: ReactNode }) {
  return (
    <DropdownMenu.SubTrigger
      className={cn(
        'flex h-7 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none',
        'data-[highlighted]:bg-hover data-[state=open]:bg-hover',
        className,
      )}
      {...props}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1">{children}</span>
      <span className="text-faint">›</span>
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        sideOffset={4}
        className={cn(
          'z-50 min-w-48 rounded-lg bg-menu p-1 text-sm text-fg shadow-menu',
          className,
        )}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}
