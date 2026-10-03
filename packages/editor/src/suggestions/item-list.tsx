import { cn } from '@workspace/ui';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SuggestionListHandle } from './floating';

export interface ItemListProps<I> {
  items: I[];
  loading?: boolean;
  command(item: I): void;
  label: string;
  emptyText: string;
  keyOf(item: I): string;
  /** Section heading shown above the first item of each section. */
  sectionOf?(item: I): string | undefined;
  renderItem(item: I): ReactNode;
  className?: string;
}

/** Keyboard-navigable list used by the @-mention and :emoji suggestions. */
function ItemListInner<I>(
  {
    items,
    loading,
    command,
    label,
    emptyText,
    keyOf,
    sectionOf,
    renderItem,
    className,
  }: ItemListProps<I>,
  ref: React.ForwardedRef<SuggestionListHandle<I>>,
) {
  const [selected, setSelected] = useState(0);
  const [prevItems, setPrevItems] = useState(items);
  const listRef = useRef<HTMLDivElement>(null);
  if (items !== prevItems) {
    setPrevItems(items);
    setSelected(0);
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event, current) {
      if (current.length === 0) return false;
      const index = current === items ? selected : 0;
      if (event.key === 'ArrowDown') setSelected((index + 1) % current.length);
      else if (event.key === 'ArrowUp') setSelected((index + current.length - 1) % current.length);
      else if (event.key === 'Enter' || event.key === 'Tab') {
        const item = current[index];
        if (item) command(item);
      } else return false;
      return true;
    },
  }));

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      className={cn(
        'max-h-72 w-72 overflow-y-auto rounded-lg bg-menu p-1 text-sm text-fg shadow-menu',
        className,
      )}
    >
      {items.length === 0 && (
        <div className="px-2 py-1.5 text-muted">{loading ? 'Searching…' : emptyText}</div>
      )}
      {items.map((item, index) => {
        const section = sectionOf?.(item);
        const showSection = section && (index === 0 || sectionOf?.(items[index - 1]!) !== section);
        return (
          <div key={keyOf(item)}>
            {showSection && (
              <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted">{section}</div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              data-index={index}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => command(item)}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left',
                index === selected && 'bg-hover',
              )}
            >
              {renderItem(item)}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export const ItemList = forwardRef(ItemListInner) as <I>(
  props: ItemListProps<I> & { ref?: React.ForwardedRef<SuggestionListHandle<I>> },
) => ReturnType<typeof ItemListInner>;
