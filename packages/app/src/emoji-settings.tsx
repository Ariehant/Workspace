/**
 * Settings → Emoji (Phase 8 N8, #7): the workspace's custom emoji. Add one by naming an
 * image; everyone in the workspace can then type `:name:` for it, or pick it as a page icon.
 */
import {
  addCustomEmoji,
  customEmojiNameProblem,
  removeCustomEmoji,
  workspaceDataDoc,
} from '@workspace/core';
import { isStandardEmoji } from '@workspace/editor';
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useApp } from './context';
import { useWorkspaceEmoji } from './custom-emoji';
import { usePeople } from './people';

/** The name suggested from an image's file name: "Team Logo.png" → "team_logo". */
export function emojiNameFrom(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

export function EmojiPanel() {
  const { workspace, platform, user, members } = useApp();
  const doc = workspaceDataDoc(workspace);
  const emoji = useWorkspaceEmoji();
  const people = usePeople(doc, members);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = name ? customEmojiNameProblem(doc, name, isStandardEmoji) : null;

  const add = async () => {
    if (!file || !name || problem) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await platform.importFile(file);
      addCustomEmoji(doc, { name, fileId: id, by: user.id }, isStandardEmoji);
      setFile(null);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The image couldn’t be added');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="emoji-settings">
      <p className="text-muted">
        Everyone in the workspace can use these: type <kbd>:name:</kbd> in a page, or pick one as a
        page icon.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 hover:bg-hover">
          <ImagePlus size={14} aria-hidden />
          {file ? file.name : 'Choose an image'}
          <input
            type="file"
            accept="image/*"
            aria-label="Emoji image"
            className="sr-only"
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              setFile(chosen);
              if (chosen && !name) setName(emojiNameFrom(chosen.name));
            }}
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">Name</span>
          <span className="flex h-8 items-center rounded-md border border-line px-2 focus-within:border-accent">
            :
            <input
              value={name}
              onChange={(event) => setName(event.target.value.trim())}
              aria-label="Emoji name"
              aria-invalid={!!problem}
              aria-describedby="emoji-name-problem"
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
            :
          </span>
        </label>
        <Button type="submit" disabled={!file || !name || !!problem || busy}>
          Add emoji
        </Button>
      </form>
      {(problem ?? error) && (
        <p id="emoji-name-problem" role="alert" className="text-xs text-danger">
          {problem ?? error}
        </p>
      )}
      {emoji.length === 0 ? (
        <p className="text-faint">No custom emoji yet.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Custom emoji">
          {emoji.map((e) => (
            <li
              key={e.name}
              className="flex h-10 items-center gap-3 rounded-md px-2 hover:bg-hover"
              data-testid="custom-emoji"
            >
              <img src={platform.fileUrl(e.fileId)} alt="" className="size-6 object-contain" />
              <span className="flex-1 font-medium">:{e.name}:</span>
              <span className="text-xs text-muted">
                {e.by ? `Added by ${people.names.get(e.by) ?? 'someone'}` : ''}
              </span>
              <button
                type="button"
                aria-label={`Remove :${e.name}:`}
                onClick={() => removeCustomEmoji(doc, e.name)}
                className="flex size-7 items-center justify-center rounded text-muted hover:bg-active"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Emoji settings on their own (until there's one Settings window). */
export function EmojiDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Emoji" className="w-[min(560px,calc(100vw-2rem))]">
        <EmojiPanel />
      </DialogContent>
    </Dialog>
  );
}
