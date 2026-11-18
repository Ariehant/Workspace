/**
 * Repeating templates (as Notion's "Repeat"): a template makes a new page from itself every
 * day, on chosen weekdays, or monthly. It's a scheduled automation of the database (one per
 * template), so it runs where automations run: on the server while the workspace syncs, or on
 * this device.
 */
import {
  deleteAutomation,
  readAutomations,
  setAutomation,
  type Automation,
  type DatabaseHandle,
  type Schedule,
} from '@workspace/database';
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { useState } from 'react';
import { useApp } from '../context';
import { ScheduleEditor, describeSchedule } from './automations-dialog';

/** The automation that repeats a template (one per template). */
export const repeatId = (templateId: string) => `repeat-${templateId}`;

/** A template's repeat, if it has one. */
export function repeatOf(handle: DatabaseHandle, templateId: string): Automation | null {
  return readAutomations(handle.doc).find((a) => a.id === repeatId(templateId)) ?? null;
}

export function RepeatDialog({
  handle,
  templateId,
  templateTitle,
  onClose,
}: {
  handle: DatabaseHandle;
  templateId: string;
  templateTitle: string;
  onClose(): void;
}) {
  const { user } = useApp();
  const existing = repeatOf(handle, templateId);
  const [on, setOn] = useState(existing?.enabled ?? true);
  const [schedule, setSchedule] = useState<Schedule>(
    existing?.trigger.kind === 'schedule'
      ? existing.trigger.schedule
      : {
          every: 'week',
          weekdays: [1],
          time: '09:00',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
  );
  const name = templateTitle || 'Untitled';

  const save = () => {
    setAutomation(handle.doc, {
      id: repeatId(templateId),
      name: `Repeat ${name}`,
      enabled: on,
      trigger: { kind: 'schedule', schedule },
      condition: null,
      actions: [{ kind: 'addPage', title: '', values: {}, templateId }],
      createdBy: existing?.createdBy ?? user.id,
      createdAt: existing?.createdAt ?? Date.now(),
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={`Repeat “${name}”`} data-testid="repeat-dialog" className="w-[460px]">
        <div className="flex flex-col gap-3 p-4 pt-2 text-sm">
          <p className="text-muted">
            A new page from this template is added on this schedule, with the template’s properties
            and content.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => setOn(e.target.checked)}
              aria-label="Repeat on"
            />
            Repeat
          </label>
          {on && <ScheduleEditor schedule={schedule} onChange={setSchedule} />}
          {on && <p className="text-xs text-muted">{describeSchedule(schedule)}</p>}
          <div className="flex justify-end gap-2 pt-1">
            {existing && (
              <Button
                onClick={() => {
                  deleteAutomation(handle.doc, existing.id);
                  onClose();
                }}
              >
                Stop repeating
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={save} data-testid="repeat-save">
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
