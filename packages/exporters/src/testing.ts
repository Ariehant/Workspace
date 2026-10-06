import { getPageContent } from '@workspace/core';
import * as Y from 'yjs';

/** Test builder: `el('paragraph', {}, 'text', el('mention', {...}))`. */
export type Spec = Y.XmlElement | Y.XmlText | string;

export function el(type: string, attrs: Record<string, unknown> = {}, ...children: Spec[]) {
  const element = new Y.XmlElement(type);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value as string);
  element.insert(
    0,
    children.map((child) => (typeof child === 'string' ? new Y.XmlText(child) : child)),
  );
  return element;
}

/** Text with marks: `marked('bold', { bold: {} })`. */
export function marked(text: string, marks: Record<string, unknown>): Y.XmlText {
  const node = new Y.XmlText();
  node.insert(0, text, marks);
  return node;
}

export function setContent(doc: Y.Doc, ...blocks: Y.XmlElement[]): Y.Doc {
  getPageContent(doc).insert(0, blocks);
  return doc;
}
