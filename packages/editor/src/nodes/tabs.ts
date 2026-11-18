/**
 * The tabs block (Notion 3.4): content in clickable tabs, one shown at a time. Each `tab`
 * holds blocks and has a title. Which tab shows is per view (not stored, like a toggle's
 * open state); moving the cursor into a hidden tab (arrow keys, a link to a block) shows it.
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tabs: {
      /** Replace the current empty block (or insert after it) with tabs. */
      insertTabs: (titles?: string[]) => ReturnType;
    };
  }
}

/** The tabs views on screen, by their element (to show the tab the cursor moves into). */
const views = new WeakMap<HTMLElement, TabsView>();

export const Tab = Node.create({
  name: 'tab',
  content: 'block+',
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') ?? '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tab"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tab', class: 'ws-tab' }), 0];
  },

  // Its own element, so the tabs view can hide it without the editor taking that for an edit.
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'ws-tab';
      dom.dataset.type = 'tab';
      dom.setAttribute('role', 'tabpanel');
      dom.setAttribute('aria-label', (node.attrs.title as string) || 'Untitled');
      if (node.attrs.id) dom.dataset.id = String(node.attrs.id);
      return {
        dom,
        contentDOM: dom,
        ignoreMutation: (mutation: ViewMutationRecord) =>
          mutation.type === 'attributes' && mutation.target === dom,
      };
    };
  },
});

export const Tabs = Node.create({
  name: 'tabs',
  group: 'block',
  content: 'tab+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="tabs"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tabs', class: 'ws-tabs' }), 0];
  },

  addCommands() {
    return {
      insertTabs:
        (titles = ['Tab 1', 'Tab 2']) =>
        ({ state, tr, dispatch }) => {
          const { schema } = state;
          const { $from } = state.selection;
          if ($from.depth < 1) return false;
          const start = $from.before($from.depth);
          const end = $from.after($from.depth);
          const replace = $from.parent.isTextblock && $from.parent.content.size === 0;
          const tabs = schema.nodes.tabs!.create(
            null,
            titles.map((title) =>
              schema.nodes.tab!.create({ title }, schema.nodes.paragraph!.create()),
            ),
          );
          if (!dispatch) return true;
          if (replace) tr.replaceWith(start, end, tabs);
          else tr.insert(end, tabs);
          const at = replace ? start : end;
          // Somewhere to go on writing after them, at the end of the page.
          const after = at + tabs.nodeSize;
          if (after >= tr.doc.content.size) tr.insert(after, schema.nodes.paragraph!.create());
          // Into the first tab's paragraph.
          tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
          return true;
        },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) =>
      new TabsView(node, editor, () => (typeof getPos === 'function' ? getPos() : undefined));
  },

  addProseMirrorPlugins() {
    return [showTabWithCursor()];
  },
});

/** Tab bar and panels; the bar is outside the editable content. */
export class TabsView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly observer: MutationObserver;
  private active = 0;
  private renaming: number | null = null;

  constructor(
    private node: PMNode,
    private readonly editor: Editor,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'ws-tabs';
    this.dom.dataset.type = 'tabs';
    this.bar = document.createElement('div');
    this.bar.className = 'ws-tabs-bar';
    this.bar.contentEditable = 'false';
    this.bar.addEventListener('keydown', (event) => this.onBarKey(event));
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'ws-tabs-body';
    this.dom.append(this.bar, this.contentDOM);
    // Panels come and go as the content changes: show the right one.
    this.observer = new MutationObserver(() => this.showActive());
    this.observer.observe(this.contentDOM, { childList: true });
    views.set(this.dom, this);
    this.renderBar();
  }

  get count(): number {
    return this.node.childCount;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.active = Math.min(this.active, node.childCount - 1);
    this.renderBar();
    queueMicrotask(() => this.showActive());
    return true;
  }

  // The bar is the view's own (buttons, the rename box); panels are hidden here too.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    return this.bar.contains(mutation.target as globalThis.Node) || mutation.target === this.dom;
  }

  stopEvent(event: Event): boolean {
    return this.bar.contains(event.target as globalThis.Node);
  }

  destroy(): void {
    this.observer.disconnect();
    views.delete(this.dom);
  }

  /** Show tab `index` (and focus its button, from the keyboard). */
  select(index: number, focus = false): void {
    if (index < 0 || index >= this.count) return;
    if (index !== this.active) {
      this.active = index;
      this.renaming = null;
      this.renderBar();
      this.showActive();
    }
    if (focus) this.bar.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  }

  /** Show tab `index` because someone chose it: the cursor goes to the end of its content. */
  private open(index: number, focus = false): void {
    const at = this.tabPos(index);
    if (at !== null && index < this.count) {
      const end = at + this.node.child(index).nodeSize - 1;
      const view = this.editor.view;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)),
      );
    }
    // After the cursor moved (which can take the focus): the tab's button keeps it.
    this.select(index, focus);
  }

  private showActive(): void {
    Array.from(this.contentDOM.children).forEach((panel, i) => {
      (panel as HTMLElement).hidden = i !== this.active;
    });
  }

  /** Where tab `index` starts in the document. */
  private tabPos(index: number): number | null {
    const pos = this.getPos();
    if (pos === undefined) return null;
    let at = pos + 1;
    for (let i = 0; i < index; i++) at += this.node.child(i).nodeSize;
    return at;
  }

  private dispatch(build: (view: EditorView) => void): void {
    if (this.editor.isEditable) build(this.editor.view);
  }

  private rename(index: number, title: string): void {
    this.renaming = null;
    const at = this.tabPos(index);
    const tab = this.node.child(index);
    if (at === null || title === tab.attrs.title) return this.renderBar();
    this.dispatch((view) =>
      view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...tab.attrs, title })),
    );
  }

  private addTab(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { schema } = this.editor.state;
    const tab = schema.nodes.tab!.create(
      { title: `Tab ${this.count + 1}` },
      schema.nodes.paragraph!.create(),
    );
    const at = pos + this.node.nodeSize - 1;
    this.active = this.count;
    this.dispatch((view) => {
      const tr = view.state.tr.insert(at, tab);
      tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    });
  }

  private deleteTab(index: number): void {
    const at = this.tabPos(index);
    if (at === null || this.count < 2) return;
    const size = this.node.child(index).nodeSize;
    this.active = Math.max(0, Math.min(this.active, this.count - 2));
    this.dispatch((view) => view.dispatch(view.state.tr.delete(at, at + size)));
  }

  /** Arrow keys move between tabs; Home and End go to the first and last. */
  private onBarKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') !== 'tab') return;
    const next =
      event.key === 'ArrowRight'
        ? (this.active + 1) % this.count
        : event.key === 'ArrowLeft'
          ? (this.active + this.count - 1) % this.count
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? this.count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    this.open(next, true);
  }

  private renderBar(): void {
    const editable = this.editor.isEditable;
    // The tabs, then (outside the tab list) deleting the open one and adding one.
    const buttons: HTMLElement[] = [];
    const extras: HTMLElement[] = [];
    this.node.forEach((tab, _offset, index) => {
      const title = (tab.attrs.title as string) || 'Untitled';
      if (this.renaming === index && editable) {
        const input = document.createElement('input');
        input.className = 'ws-tabs-rename';
        input.value = tab.attrs.title as string;
        input.setAttribute('aria-label', 'Tab name');
        let done = false;
        const finish = (keep: boolean) => {
          if (done) return;
          done = true;
          if (keep) this.rename(index, input.value.trim() || title);
          else {
            this.renaming = null;
            this.renderBar();
          }
        };
        input.addEventListener('keydown', (event) => {
          event.stopPropagation();
          if (event.key === 'Enter') finish(true);
          else if (event.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        buttons.push(input);
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
        return;
      }
      const selected = index === this.active;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ws-tabs-tab';
      button.textContent = title;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (editable && selected) button.title = 'Click to rename';
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (selected && editable) {
          this.renaming = index;
          this.renderBar();
        } else this.open(index);
      });
      buttons.push(button);
      if (selected && editable && this.count > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ws-tabs-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Delete tab ${title}`);
        remove.addEventListener('mousedown', (event) => event.preventDefault());
        remove.addEventListener('click', () => this.deleteTab(index));
        extras.push(remove);
      }
    });
    if (editable) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ws-tabs-add';
      add.textContent = '+';
      add.setAttribute('aria-label', 'Add tab');
      add.addEventListener('mousedown', (event) => event.preventDefault());
      add.addEventListener('click', () => this.addTab());
      extras.push(add);
    }
    const list = document.createElement('div');
    list.className = 'ws-tabs-list';
    list.setAttribute('role', 'tablist');
    list.append(...buttons);
    this.bar.replaceChildren(list, ...extras);
  }
}

/** The cursor moved into a hidden tab: show it. */
function showTabWithCursor() {
  return new Plugin({
    key: new PluginKey('showTabWithCursor'),
    view: () => ({
      update(view, previous) {
        if (previous && previous.selection.eq(view.state.selection)) return;
        const { $head } = view.state.selection;
        for (let depth = $head.depth; depth > 0; depth--) {
          if ($head.node(depth).type.name !== 'tab') continue;
          const dom = view.nodeDOM($head.before(depth - 1));
          if (dom instanceof HTMLElement) views.get(dom)?.select($head.index(depth - 1));
        }
      },
    }),
  });
}
