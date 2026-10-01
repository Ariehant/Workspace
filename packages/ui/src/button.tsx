import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 px-3 h-8',
  ghost: 'text-muted hover:bg-hover hover:text-fg px-2 h-7',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors select-none',
        'focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the native tooltip. */
  label: string;
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded text-muted transition-colors',
        'hover:bg-active hover:text-fg focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' ? 'size-5' : 'size-7',
        className,
      )}
      {...props}
    />
  );
});
