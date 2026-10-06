import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import type { ButtonConfig, ButtonStep } from '@workspace/core';
import { cn } from '@workspace/ui';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useEditorServices, type EditorServices } from '../services';
import { dataAttr } from './atom';
import { docContent } from './synced-block';

/** Steps are kept as JSON in a `data-steps` attribute. */
const stepsAttr = {
  default: [] as ButtonStep[],
  parseHTML: (el: HTMLElement) => {
    try {
      return JSON.parse(el.getAttribute('data-steps') ?? '[]') as ButtonStep[];
    } catch {
      return [];
    }
  },
  renderHTML: (attrs: Record<string, unknown>) => ({
    'data-steps': JSON.stringify(attrs.steps ?? []),
  }),
};

export const configOf = (attrs: Record<string, unknown>): ButtonConfig => ({
  label: (attrs.label as string | null) ?? '',
  color: (attrs.color as string | null) ?? 'default',
  steps: (attrs.steps as ButtonStep[] | null) ?? [],
});

/** Insert a button's template blocks (its own doc) above or below it. */
async function insertTemplate(
  editor: Editor,
  services: EditorServices,
  buttonId: string,
  getPos: () => number | undefined,
  placement: 'above' | 'below',
): Promise<void> {
  const nodes = await docContent(editor, services, buttonId);
  const pos = getPos();
  if (pos === undefined) return;
  const button = editor.state.doc.nodeAt(pos);
  if (!button) return;
  const at = placement === 'above' ? pos : pos + button.nodeSize;
  editor.view.dispatch(editor.state.tr.insert(at, nodes));
}

function ButtonView({ node, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const services = useEditorServices();
  const [running, setRunning] = useState(false);
  const config = configOf(node.attrs);
  const buttonId = node.attrs.buttonId as string;
  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      await services.runButton(config, {
        insertBlocks: (placement) => insertTemplate(editor, services, buttonId, getPos, placement),
      });
    } finally {
      setRunning(false);
    }
  };
  const edit = async () => {
    const next = await services.editButton(config, buttonId);
    if (next) updateAttributes(next);
  };
  return (
    <NodeViewWrapper
      data-testid="button-block"
      className="group/button flex items-center gap-1 py-0.5"
    >
      <div contentEditable={false} className="flex items-center gap-1">
        <button
          type="button"
          disabled={running}
          onClick={() => void run()}
          data-color={config.color}
          className={cn(
            'ws-button inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium hover:bg-hover disabled:opacity-60',
          )}
        >
          {config.label || 'Button'}
        </button>
        {editor.isEditable && (
          <button
            type="button"
            aria-label="Edit button"
            onClick={() => void edit()}
            className="flex size-7 items-center justify-center rounded text-muted opacity-0 group-hover/button:opacity-100 hover:bg-hover"
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * A button block: clicking it runs its steps (insert template blocks, add or edit
 * database pages, open a page, confirm). Its template blocks live in a doc with the
 * button's id.
 */
export const ButtonBlock = Node.create({
  name: 'button',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    buttonId: dataAttr('buttonId'),
    label: dataAttr('label', ''),
    color: dataAttr('color', 'default'),
    steps: stepsAttr,
  }),
  parseHTML: () => [{ tag: 'div[data-type="button"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'button' }),
  ],
  addNodeView: () =>
    ReactNodeViewRenderer(ButtonView, { stopEvent: () => true, ignoreMutation: () => true }),
});
