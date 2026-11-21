import type {
  ButtonConfig,
  DriveFileRef,
  DriveFileStatus,
  LinkedFileRef,
  LinkedFileStatus,
  PreviewKind,
} from '@workspace/core';
import type { LucideIcon } from 'lucide-react';
import type * as Y from 'yjs';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

export interface PageRef {
  id: string;
  title: string;
  icon: string | null;
  /** The page or an ancestor is in the trash. */
  inTrash: boolean;
  /** A database page (linked views can show it). */
  isDatabase?: boolean;
}

/** Someone who can be @-mentioned. */
export interface PersonRef {
  id: string;
  name: string;
  /** A picture (`data:` URL), or null. */
  avatar: string | null;
}

/** An attachment stored in the workspace. */
export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Metadata for a web bookmark card. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string | null;
  icon: string | null;
  siteName: string | null;
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
  /**
   * What a link to a page that isn't here shows (default "Deleted page"). In a server
   * workspace that's mostly a page the person can't see: "No access".
   */
  missingPage?: string;
  /** Pages that can be linked to, most relevant first. */
  listPages(): PageRef[];
  /** Ancestors of the current page, then the page itself. */
  getBreadcrumb(): PageRef[];
  navigate(id: string): void;
  /** Create an empty sub-page of the current page and return its id. */
  createSubpage(): string;
  /**
   * Create a database inside the current page (`inline`: shown in the page, else a
   * full-page database linked from it). Resolves its id once it is set up.
   */
  createDatabase(inline: boolean): Promise<string>;
  /** The UI of an inline database block (database views live in the app). */
  renderDatabase(databaseId: string): ReactNode;
  /** Turn a simple table's cells into a new inline database; resolves its id. */
  tableToDatabase(cells: string[][], header: boolean): Promise<string>;
  /** A database's first view as simple-table cells; the database goes to the trash. */
  databaseToTable(databaseId: string): Promise<string[][]>;
  /** How many pages show a synced block (from the search index). */
  syncedPlaces(syncedId: string): Promise<number>;
  /** Load another doc (synced block content, button templates) while it's shown. */
  acquireDoc(id: string): { ready: Promise<Y.Doc>; release(): void };
  /** Run a button's steps; `insertBlocks` puts its template blocks in the page. */
  runButton(
    config: ButtonConfig,
    hooks: { insertBlocks(placement: 'above' | 'below'): Promise<void> },
  ): Promise<void>;
  /** Edit a button (label, color, steps); resolves null when cancelled. */
  editButton(config: ButtonConfig, buttonId: string): Promise<ButtonConfig | null>;
  /** A linked view of a database: its own views (`viewSet`) over the source's rows. */
  renderLinkedDatabase(databaseId: string, viewSet: string): ReactNode;
  /** Called whenever any page metadata changes. */
  subscribe(listener: () => void): () => void;
  /** Store a file (pasted, dropped or picked) in the workspace. */
  uploadFile(file: File): Promise<FileRef>;
  /** URL the renderer can load a stored file from. */
  fileUrl(id: string): string;
  /** Open a stored file with the system's default app. */
  openFile(id: string): void;
  /**
   * A file's preview in the page (a Word document, an Excel workbook, a PDF), from a URL the
   * renderer can load. Where the app provides one.
   */
  renderFilePreview?(source: { url: string; name: string; kind: PreviewKind }): ReactNode;
  linkPreview(url: string): Promise<LinkPreview | null>;
  /**
   * Linked files (Phase 8 N9): pointers to files on this computer instead of copies. Only
   * where the host has files of its own (the desktop); elsewhere a link says where it is.
   */
  linkedFiles?: {
    /** Pick files to link (none when cancelled). */
    pick(): Promise<LinkedFileRef[]>;
    /** Pick where a moved file is now. */
    locate(): Promise<LinkedFileRef | null>;
    status(ref: LinkedFileRef): Promise<LinkedFileStatus>;
    open(ref: LinkedFileRef): Promise<boolean>;
    /** Show it in the file manager. */
    reveal(ref: LinkedFileRef): Promise<boolean>;
    /** A URL a linked image shows from. */
    previewUrl(ref: LinkedFileRef): string;
    /** Open Settings at Linked folders. */
    setUpFolders(): void;
  };
  /**
   * Google Drive (Phase 8 N9): files picked with Google's Picker, where the host connects to
   * Drive (the desktop). Elsewhere a Drive block shows what it last knew and links to Drive.
   */
  drive?: {
    /** Pick files (none if cancelled; not connected opens Settings). */
    pick(): Promise<DriveFileRef[]>;
    status(fileId: string): Promise<DriveFileStatus>;
    open(fileId: string): Promise<boolean>;
    /** Open Settings at Connections. */
    setUp(): void;
    /** The connection changed (connected, disconnected). */
    subscribe(listener: () => void): () => void;
    /** Where Drive's picture of a file shows from (when its status says it has one). */
    thumbnailUrl?(fileId: string): string;
  };
  /**
   * On a database row's page, for someone who may change the database's properties: the
   * property types `/relation`, `/select`… add to the database (`types` is empty when
   * they can't now).
   */
  rowProperties?: {
    types(): { type: string; label: string; icon: LucideIcon }[];
    /** Add one (relations, rollups and formulas open their setup; others their value). */
    add(type: string): void;
  };
  /** People to @-mention: the workspace's members (current ones in `list`). */
  people: {
    /** Who's typing (a reminder they set is theirs: only they're reminded). */
    me?: string;
    list(): PersonRef[];
    get(id: string): PersonRef | null;
    subscribe(listener: () => void): () => void;
  };
  /** The workspace's custom emoji (`:name:` → an uploaded image). */
  customEmoji?: {
    list(): { name: string; fileId: string }[];
    subscribe(listener: () => void): () => void;
  };
  /** The workspace's KaTeX macros (`\R` -> `\mathbb{R}`), shared by every page. */
  mathMacros: {
    get(): Record<string, string>;
    set(macros: Record<string, string>): void;
    subscribe(listener: () => void): () => void;
  };
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

/** Someone mentioned, kept current (name and picture changes). */
export function usePersonRef(id: string | null): PersonRef | null {
  const services = useEditorServices();
  const key = useSyncExternalStore(services.people.subscribe, () => {
    const person = id ? services.people.get(id) : null;
    return person ? `${person.name}\u0000${person.avatar ?? ''}` : '';
  });
  return key && id ? services.people.get(id) : null;
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
  /** Offer to turn a just-pasted link at [from, to) into a bookmark or embed. */
  pastedUrl: ((url: string, from: number, to: number) => void) | null;
  /** Ask the user to pick a page; resolves with `null` if they cancel. */
  pickPage:
    ((anchor: DOMRect, options?: { databasesOnly?: boolean }) => Promise<PageRef | null>) | null;
  /** Open the equation editor for the math node at `pos`. */
  editMath: ((node: PMNode, pos: number) => void) | null;
  openFind: (() => void) | null;
}

export const EMPTY_UI_BRIDGE: UiBridge = {
  services: null,
  pastedUrl: null,
  pickPage: null,
  editMath: null,
  openFind: null,
};

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
