import { cn } from './cn';

/**
 * A person's picture, or their initial on a tint picked from their id. An emoji (an
 * integration's icon) shows on the tint instead of the initial.
 */
export function Avatar({
  name,
  src,
  id,
  size = 20,
  className,
}: {
  name: string;
  src?: string | null;
  /** Keeps someone's color the same everywhere (defaults to the name). */
  id?: string;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.5)) };
  const emoji = src && isEmoji(src) ? src : null;
  if (src && !emoji) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        style={style}
        className={cn('shrink-0 rounded-full object-cover', className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        ...style,
        // The editor's color palette (with a plain fallback outside it).
        backgroundColor: `var(--ws-${TINTS[hash(id ?? name) % TINTS.length]}-bg, var(--ws-active))`,
      }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-medium text-fg',
        className,
      )}
    >
      {emoji ?? (name.trim().charAt(0).toUpperCase() || '?')}
    </span>
  );
}

/** A few characters with no URL in them (not a picture's address). */
const isEmoji = (src: string) => src.length <= 16 && !/[/:.]/.test(src);

const TINTS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}
