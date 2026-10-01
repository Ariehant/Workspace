import { cn } from '@workspace/ui';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BLOCK_GROUP_LABELS, type BlockDefinition } from '../blocks/registry';

export interface SlashMenuListProps {
  items: BlockDefinition[];
  command(item: BlockDefinition): void;
}

export interface SlashMenuListHandle {
  onKeyDown(event: KeyboardEvent): boolean;
}

export const SlashMenuList = forwardRef<SlashMenuListHandle, SlashMenuListProps>(
  function SlashMenuList({ items, command }, ref) {
    const [selected, setSelected] = useState(0);
    const [prevItems, setPrevItems] = useState(items);
    const listRef = useRef<HTMLDivElement>(null);

    // Reset the highlight whenever the query changes the results.
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
      onKeyDown(event) {
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setSelected((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    return (
      <div
        ref={listRef}
        role="listbox"
        aria-label="Blocks"
        className="max-h-80 w-80 overflow-y-auto rounded-lg bg-menu p-1 text-sm text-fg shadow-menu"
      >
        {items.length === 0 && <div className="px-2 py-1.5 text-muted">No results</div>}
        {items.map((item, index) => {
          const showGroup = index === 0 || items[index - 1]!.group !== item.group;
          const Icon = item.icon;
          return (
            <div key={item.id}>
              {showGroup && (
                <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted">
                  {BLOCK_GROUP_LABELS[item.group]}
                </div>
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
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left',
                  index === selected && 'bg-hover',
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-line bg-surface">
                  <Icon size={20} strokeWidth={1.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.title}</span>
                  <span className="block truncate text-xs text-muted">{item.description}</span>
                </span>
                {item.shortcut && (
                  <span className="shrink-0 font-mono text-xs text-faint">{item.shortcut}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    );
  },
);
