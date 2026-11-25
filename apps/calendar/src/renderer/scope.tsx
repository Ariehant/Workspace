/** Which occurrences of a recurring event a change or a delete is for. */
import { Button, Dialog, DialogContent } from '@workspace/ui';
import type { EditScope } from '../shared/types';

const CHOICES: { scope: EditScope; label: string }[] = [
  { scope: 'this', label: 'This event' },
  { scope: 'following', label: 'This and following events' },
  { scope: 'all', label: 'All events' },
];

export function ScopeDialog({
  action,
  onChoose,
  onCancel,
}: {
  action: 'change' | 'delete';
  onChoose: (scope: EditScope) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        title={action === 'delete' ? 'Delete recurring event' : 'Change recurring event'}
        className="w-[min(360px,calc(100vw-32px))]"
      >
        <div className="flex flex-col gap-2 p-4">
          {CHOICES.map(({ scope, label }, i) => (
            <Button
              key={scope}
              autoFocus={i === 0}
              variant={i === 0 ? 'primary' : undefined}
              className="justify-start"
              onClick={() => onChoose(scope)}
            >
              {label}
            </Button>
          ))}
          <Button className="mt-1 justify-start text-muted" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
