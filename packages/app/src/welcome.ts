import { createPage, getPageContent, type DocClient } from '@workspace/core';
import * as Y from 'yjs';

type Node = [type: string, text: string, attrs?: Record<string, unknown>];

const WELCOME: Node[] = [
  [
    'paragraph',
    'Welcome! This is your workspace. Everything is stored on this computer and works offline.',
  ],
  ['heading', 'The basics', { level: 2 }],
  ['bullet', 'Create pages with “New page” in the sidebar, or press Ctrl+N.'],
  ['bullet', 'Nest pages by clicking + next to a page in the sidebar.'],
  ['bullet', 'Type # and a space for a heading, - for a list, > for a quote, ``` for code.'],
  ['bullet', 'Select text and press Ctrl+B or Ctrl+I to format it.'],
  ['heading', 'Coming next', { level: 2 }],
  [
    'paragraph',
    'Slash commands, databases, sync between devices and collaboration are on the roadmap.',
  ],
];

function element(
  type: string,
  attrs: Record<string, unknown> = {},
  children: Y.XmlElement[] | string = [],
) {
  const el = new Y.XmlElement(type);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value as string);
  el.insert(0, typeof children === 'string' ? [new Y.XmlText(children)] : children);
  return el;
}

/** Create the "Getting started" page shown on first launch. */
export async function createWelcomePage(client: DocClient, workspace: Y.Doc): Promise<string> {
  const id = createPage(workspace, { title: 'Getting started', icon: '👋' });
  const handle = client.acquire(id);
  try {
    await handle.ready;
    const blocks = WELCOME.map(([type, text, attrs]) =>
      type === 'bullet'
        ? element('bulletList', {}, [element('listItem', {}, [element('paragraph', {}, text)])])
        : element(type, attrs, text),
    );
    getPageContent(handle.doc).insert(0, blocks);
  } finally {
    handle.release();
  }
  return id;
}
