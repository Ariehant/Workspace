import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import type { ComponentType, RefAttributes } from 'react';

/** Props every suggestion list receives. */
export interface SuggestionListProps<I> {
  items: I[];
  command(item: I): void;
  query: string;
  /** Results for the current query are still being computed. */
  loading: boolean;
}

export interface SuggestionListHandle<I> {
  /** `current` are the newest results, which may be newer than the rendered ones. */
  onKeyDown(event: KeyboardEvent, current: I[]): boolean;
}

export interface FloatingOptions<I> {
  testId: string;
  /** Close the suggestion early (e.g. after typing well past any match). */
  shouldExit?(props: SuggestionProps<I, I>): boolean;
  exit(props: SuggestionProps<I, I>): void;
}

/**
 * `render` for a TipTap Suggestion: shows a React list in a floating box under the
 * cursor and routes arrow keys / Enter to it. Keys are handled against the newest
 * results, which React may not have rendered yet when someone types fast.
 */
export function floatingList<I>(
  List: ComponentType<SuggestionListProps<I> & RefAttributes<SuggestionListHandle<I>>>,
  options: FloatingOptions<I>,
) {
  return () => {
    let renderer: ReactRenderer<SuggestionListHandle<I>, SuggestionListProps<I>> | null = null;
    let element: HTMLDivElement | null = null;
    let latest: SuggestionProps<I, I> | null = null;

    const place = (props: SuggestionProps<I, I>) => {
      const rect = props.clientRect?.();
      if (!element || !rect) return;
      void computePosition({ getBoundingClientRect: () => rect }, element, {
        placement: 'bottom-start',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (element) Object.assign(element.style, { left: `${x}px`, top: `${y}px` });
      });
    };

    const listProps = (props: SuggestionProps<I, I>): SuggestionListProps<I> => ({
      items: props.items,
      command: props.command,
      query: props.query,
      loading: Boolean(props.loading),
    });

    return {
      onStart(props: SuggestionProps<I, I>) {
        latest = props;
        renderer = new ReactRenderer(List, { editor: props.editor, props: listProps(props) });
        element = document.createElement('div');
        element.className = 'ws-floating';
        element.dataset.testid = options.testId;
        element.append(renderer.element);
        document.body.append(element);
        place(props);
      },
      onUpdate(props: SuggestionProps<I, I>) {
        latest = props;
        // Items arrive asynchronously: while loading, `items` is empty and says nothing.
        if (!props.loading && options.shouldExit?.(props)) {
          options.exit(props);
          return;
        }
        renderer?.updateProps(listProps(props));
        place(props);
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (event.key === 'Escape') {
          element?.remove();
          return false;
        }
        if (latest?.loading) return event.key === 'Enter' || event.key === 'Tab'; // wait for results
        return (latest && renderer?.ref?.onKeyDown(event, latest.items)) ?? false;
      },
      onExit() {
        element?.remove();
        renderer?.destroy();
        element = null;
        renderer = null;
        latest = null;
      },
    };
  };
}
