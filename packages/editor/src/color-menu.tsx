import { cn } from '@workspace/ui';
import { COLOR_LABELS, COLOR_NAMES, type ColorValue } from './nodes/colors';

/** "A" swatch showing a text or background color. */
export function ColorSwatch({ value }: { value: ColorValue | null }) {
  const background = value?.endsWith('_background');
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded border border-line text-xs font-semibold',
        value ? `ws-swatch-${value}` : '',
        background && 'text-fg',
      )}
    >
      A
    </span>
  );
}

export interface ColorChoice {
  value: ColorValue | null;
  label: string;
}

/** Default, then each text color, then each background color (Notion's order). */
export const COLOR_CHOICES: { section: string; choices: ColorChoice[] }[] = [
  {
    section: 'Text color',
    choices: [
      { value: null, label: 'Default text' },
      ...COLOR_NAMES.map((n) => ({ value: n as ColorValue, label: `${COLOR_LABELS[n]} text` })),
    ],
  },
  {
    section: 'Background color',
    choices: [
      { value: null, label: 'Default background' },
      ...COLOR_NAMES.map((n) => ({
        value: `${n}_background` as ColorValue,
        label: `${COLOR_LABELS[n]} background`,
      })),
    ],
  },
];

/** Color list for the selection toolbar (plain buttons that keep editor focus). */
export function ColorPanel({
  current,
  onPick,
}: {
  current: string | null;
  onPick(value: ColorValue | null): void;
}) {
  return (
    <div
      role="menu"
      aria-label="Color"
      className="max-h-80 overflow-y-auto border-t border-line p-1"
    >
      {COLOR_CHOICES.map(({ section, choices }) => (
        <div key={section}>
          <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted">{section}</div>
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitem"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(choice.value)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover"
            >
              <ColorSwatch value={choice.value} />
              <span className="flex-1">{choice.label}</span>
              {(choice.value ?? null) === (current ?? null) && choice.value !== null && (
                <span aria-hidden>✓</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
