import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createContext, useContext, useSyncExternalStore } from 'react';

export interface PageRef {
  id: string;
  title: string;
  icon: string | null;
  /** The page or an ancestor is in the trash. */
  inTrash: boolean;
}

/**
 * What the editor needs from the workspace around it: page titles for page links
 * and breadcrumbs, navigation, and creating sub-pages. Provided by the app, so the
 * editor package has no dependency on how pages are stored.
 */
export interface EditorServices {
  /** The page being edited. */
  pageId: string;
  getPage(id: string): PageRef | null;
  /** Pages that can be linked to, most relevant first. */
  listPages(): PageRef[];
  /** Ancestors of the current page, then the page itself. */
  getBreadcrumb(): PageRef[];
  navigate(id: string): void;
  /** Create an empty sub-page of the current page and return its id. */
  createSubpage(): string;
  /** Called whenever any page metadata changes. */
  subscribe(listener: () => void): () => void;
}

export const EditorServicesContext = createContext<EditorServices | null>(null);

export function useEditorServices(): EditorServices {
  const services = useContext(EditorServicesContext);
  if (!services) throw new Error('EditorServicesContext is missing');
  return services;
}

/** Re-render when page metadata changes; returns a page lookup. */
export function usePageRef(id: string | null): PageRef | null {
  const services = useEditorServices();
  const key = useSyncExternalStore(services.subscribe, () => {
    const page = id ? services.getPage(id) : null;
    return page ? `${page.title}\u0000${page.icon ?? ''}\u0000${page.inTrash}` : '';
  });
  return key && id ? services.getPage(id) : null;
}

export function useBreadcrumb(): PageRef[] {
  const services = useEditorServices();
  const key = useSyncExternalStore(services.subscribe, () =>
    services
      .getBreadcrumb()
      .map((p) => `${p.id}:${p.title}:${p.icon ?? ''}`)
      .join('|'),
  );
  // `key` changes exactly when the breadcrumb does.
  return key ? services.getBreadcrumb() : [];
}

/** Handles to React UI owned by <PageEditor>, filled in once it mounts. */
export interface UiBridge {
  services: EditorServices | null;
  /** Ask the user to pick a page; resolves with `null` if they cancel. */
  pickPage: ((anchor: DOMRect) => Promise<PageRef | null>) | null;
  /** Open the equation editor for the math node at `pos`. */
  editMath: ((node: PMNode, pos: number) => void) | null;
}

export const EMPTY_UI_BRIDGE: UiBridge = { services: null, pickPage: null, editMath: null };

/**
 * Mutable holder for the bridge: an external store, like a ref. <PageEditor> sets
 * it from an effect; commands, plugins and event handlers read it. Nothing reads it
 * during render.
 */
export class UiBridgeHandle {
  current: UiBridge = EMPTY_UI_BRIDGE;
  set(next: UiBridge): void {
    this.current = next;
  }
}

/**
 * Extension storage is shallow-copied by TipTap when the editor is created, so it
 * holds the handle, whose `current` is filled in later, rather than its value.
 */
export interface UiBridgeStorage {
  ref: UiBridgeHandle;
}

declare module '@tiptap/core' {
  interface Storage {
    uiBridge: UiBridgeStorage;
  }
}

/**
 * Lets commands and node views reach React UI owned by <PageEditor> (pickers,
 * popovers) and the editor services, through `editor.storage.uiBridge.ref.current.current`.
 */
export function uiBridgeExtension(ref: UiBridgeHandle) {
  return Extension.create<object, UiBridgeStorage>({
    name: 'uiBridge',
    addStorage: () => ({ ref }),
  });
}
