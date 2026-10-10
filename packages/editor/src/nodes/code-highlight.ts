import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { lowlight } from './languages';

/**
 * Code highlighting that keeps up with long pages: a transaction re-highlights only the
 * code blocks it touched, and maps the other decorations. (The stock lowlight plugin walks
 * the whole document twice on every transaction, selection changes included.)
 */

/** The nodes of `typeName` in the transaction's document that its steps changed. */
export function touchedNodes(tr: Transaction, typeName: string): { node: PMNode; pos: number }[] {
  if (!tr.docChanged) return [];
  const ranges: [number, number][] = [];
  tr.steps.forEach((step, i) => {
    const after = tr.mapping.slice(i + 1);
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([after.map(newStart, -1), after.map(newEnd, 1)]);
    });
  });
  const found = new Map<number, PMNode>();
  const size = tr.doc.content.size;
  for (const [from, to] of ranges) {
    tr.doc.nodesBetween(Math.max(0, from - 1), Math.min(size, to + 1), (node, pos) => {
      if (node.type.name === typeName) {
        found.set(pos, node);
        return false;
      }
      // Code blocks are textblocks: nothing inside another textblock is one.
      return !node.isTextblock;
    });
  }
  return [...found].map(([pos, node]) => ({ node, pos }));
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

/** Text runs of a lowlight tree, with the classes that apply to each. */
function runs(nodes: HastNode[], classes: string[] = []): { text: string; classes: string[] }[] {
  return nodes.flatMap((node) => {
    if (node.type === 'text') return [{ text: node.value ?? '', classes }];
    const own = node.properties?.className ?? [];
    return runs(node.children ?? [], [...classes, ...own]);
  });
}

function highlightBlock(node: PMNode, pos: number, defaultLanguage: string): Decoration[] {
  const text = node.textContent;
  if (!text) return [];
  const language = (node.attrs.language as string | null) || defaultLanguage;
  const tree =
    language && lowlight.registered(language)
      ? lowlight.highlight(language, text)
      : lowlight.highlightAuto(text);
  const decorations: Decoration[] = [];
  let from = pos + 1;
  for (const run of runs(tree.children as HastNode[])) {
    const to = from + run.text.length;
    if (run.classes.length)
      decorations.push(Decoration.inline(from, to, { class: run.classes.join(' ') }));
    from = to;
  }
  return decorations;
}

function highlightAll(doc: PMNode, typeName: string, defaultLanguage: string): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === typeName) {
      decorations.push(...highlightBlock(node, pos, defaultLanguage));
      return false;
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
}

export const codeHighlightKey = new PluginKey<DecorationSet>('codeHighlight');

export function codeHighlightPlugin(typeName: string, defaultLanguage: string): Plugin {
  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_, state) => highlightAll(state.doc, typeName, defaultLanguage),
      apply: (tr, old) => {
        if (!tr.docChanged) return old;
        let set = old.map(tr.mapping, tr.doc);
        for (const { node, pos } of touchedNodes(tr, typeName)) {
          const end = pos + node.nodeSize;
          set = set
            .remove(set.find(pos, end))
            .add(tr.doc, highlightBlock(node, pos, defaultLanguage));
        }
        return set;
      },
    },
    props: { decorations: (state) => codeHighlightKey.getState(state) },
  });
}
