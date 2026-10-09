/**
 * A public form's page (`/f/<token>`): plain HTML that posts back to itself, no script.
 * Its questions are inputs named by property id; person questions aren't asked here
 * (nobody signed in can pick workspace members).
 */
import { escapeHtml } from '@workspace/exporters';
import { optionsOf, type FormConfig, type FormQuestion, type Property } from '@workspace/database';

/** The field a robot fills in and a person never sees. */
export const HONEYPOT = 'website';

export interface FormPage {
  form: FormConfig;
  /** The database's title, when the form has none. */
  fallbackTitle: string;
  questions: { question: FormQuestion; property: Property }[];
  /** What was sent (kept when there are errors). */
  values?: Readonly<Record<string, string | string[]>>;
  errors?: ReadonlyMap<string | null, string>;
}

const STYLE = `
  body { margin: 0; background: #f7f7f5; color: #37352f;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 40px auto; padding: 32px; background: #fff;
    border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { margin: 0 0 8px; font-size: 28px; }
  p.description { margin: 0 0 24px; color: #787774; white-space: pre-wrap; }
  .q { margin: 0 0 20px; }
  .q > label, .q > .label { display: block; font-weight: 600; margin-bottom: 2px; }
  .q .hint { color: #787774; font-size: 14px; margin-bottom: 6px; }
  .q .required { color: #e03e3e; }
  input[type=text], input[type=number], input[type=date], input[type=url], input[type=email],
  input[type=tel], textarea, select { box-sizing: border-box; width: 100%; padding: 8px 10px;
    font: inherit; border: 1px solid #d3d1cb; border-radius: 6px; background: #fff; }
  textarea { min-height: 96px; }
  .choice { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
  .error { color: #e03e3e; font-size: 14px; margin-top: 4px; }
  .hp { position: absolute; left: -10000px; }
  button { padding: 10px 18px; font: inherit; font-weight: 600; color: #fff;
    background: #2383e2; border: 0; border-radius: 6px; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #191919; color: #e6e6e4; }
    main { background: #202020; box-shadow: none; }
    input, textarea, select { background: #2a2a2a !important; color: inherit;
      border-color: #3f3f3f !important; }
  }
`;

const page = (title: string, body: string) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;

function input(question: FormQuestion, property: Property, value: string | string[] | undefined) {
  const name = escapeHtml(property.id);
  const one = escapeHtml(Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
  const required = question.required ? ' required' : '';
  const id = `q-${name}`;
  switch (property.type) {
    case 'text':
      return `<textarea id="${id}" name="${name}" maxlength="2000"${required}>${one}</textarea>`;
    case 'number':
      return `<input id="${id}" type="number" step="any" name="${name}" value="${one}"${required}>`;
    case 'date':
      return `<input id="${id}" type="date" name="${name}" value="${one}"${required}>`;
    case 'url':
      return `<input id="${id}" type="url" name="${name}" value="${one}" maxlength="2000"${required}>`;
    case 'email':
      return `<input id="${id}" type="email" name="${name}" value="${one}" maxlength="2000"${required}>`;
    case 'phone':
      return `<input id="${id}" type="tel" name="${name}" value="${one}" maxlength="40"${required}>`;
    case 'checkbox':
      return `<label class="choice"><input id="${id}" type="checkbox" name="${name}"${
        one ? ' checked' : ''
      }${required}> Yes</label>`;
    case 'select':
    case 'status':
      return `<select id="${id}" name="${name}"${required}><option value="">Choose…</option>${optionsOf(
        property,
      )
        .map(
          (o) =>
            `<option value="${escapeHtml(o.id)}"${o.id === one ? ' selected' : ''}>${escapeHtml(o.name)}</option>`,
        )
        .join('')}</select>`;
    case 'multiSelect': {
      const chosen = new Set(Array.isArray(value) ? value : value ? [value] : []);
      if (optionsOf(property).length === 0) return '<div class="hint">No options yet.</div>';
      return optionsOf(property)
        .map(
          (o) =>
            `<label class="choice"><input type="checkbox" name="${name}" value="${escapeHtml(o.id)}"${
              chosen.has(o.id) ? ' checked' : ''
            }> ${escapeHtml(o.name)}</label>`,
        )
        .join('');
    }
    default:
      return `<input id="${id}" type="text" name="${name}" value="${one}" maxlength="2000"${required}>`;
  }
}

/** The form, to fill in (again, with what's wrong, after a refused post). */
export function renderForm({ form, fallbackTitle, questions, values = {}, errors }: FormPage) {
  const title = form.title || fallbackTitle || 'Form';
  const general = errors?.get(null);
  const body = `
<h1>${escapeHtml(title)}</h1>
${form.description ? `<p class="description">${escapeHtml(form.description)}</p>` : ''}
<form method="post" accept-charset="utf-8">
${general ? `<p class="error" role="alert">${escapeHtml(general)}</p>` : ''}
${questions
  .map(({ question, property }) => {
    const label = escapeHtml(question.label || property.name);
    const error = errors?.get(property.id);
    const multi = property.type === 'multiSelect' || property.type === 'checkbox';
    return `<div class="q">
  ${
    multi
      ? `<span class="label">${label}${question.required ? ' <span class="required">*</span>' : ''}</span>`
      : `<label for="q-${escapeHtml(property.id)}">${label}${
          question.required ? ' <span class="required">*</span>' : ''
        }</label>`
  }
  ${question.description ? `<div class="hint">${escapeHtml(question.description)}</div>` : ''}
  ${input(question, property, values[property.id])}
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
</div>`;
  })
  .join('\n')}
<div class="hp" aria-hidden="true"><label>Website <input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
<button type="submit">Submit</button>
</form>`;
  return page(title, body);
}

/** After submitting. */
export function renderSubmitted(form: FormConfig, fallbackTitle: string) {
  const title = form.title || fallbackTitle || 'Form';
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p class="description" role="status">${escapeHtml(
      form.submittedMessage || 'Thanks! Your response was recorded.',
    )}</p>`,
  );
}

/** A link that doesn't (or no longer) work. */
export const renderGone = () =>
  page(
    'Form not found',
    '<h1>Form not found</h1><p class="description">This form isn’t available. Ask whoever sent it for a new link.</p>',
  );
