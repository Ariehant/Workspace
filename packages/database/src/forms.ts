/**
 * Forms (Phase 6 M2): a form view asks some of a database's properties as questions, and
 * each response becomes a new row. The server checks a response here before writing it,
 * so a form only ever writes answers to its own questions, in its properties' shapes.
 */
import {
  TITLE_PROPERTY_ID,
  type DateValue,
  type FormConfig,
  type Property,
  type PropertyType,
} from './schema';

/** Properties a form can ask (computed ones, files and relations can't be). */
export const FORM_QUESTION_TYPES: readonly PropertyType[] = [
  'title',
  'text',
  'number',
  'select',
  'multiSelect',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
  'person',
];

export const canAsk = (type: PropertyType) => FORM_QUESTION_TYPES.includes(type);

/** Longest text answer (as Notion's rich text items). */
export const MAX_ANSWER_LENGTH = 2000;

/** A new form: every property it can ask, the title first, none required. */
export function defaultForm(properties: readonly Property[]): FormConfig {
  return {
    title: '',
    description: '',
    questions: properties
      .filter((p) => canAsk(p.type))
      .map((p) => ({ propertyId: p.id, label: '', description: '', required: false })),
    audience: 'access',
    submittedMessage: 'Thanks! Your response was recorded.',
    notify: false,
    createdBy: null,
  };
}

/** The form's questions with their properties (questions whose property is gone are left out). */
export function formQuestions(properties: readonly Property[], form: FormConfig) {
  const byId = new Map(properties.map((p) => [p.id, p]));
  return form.questions.flatMap((question) => {
    const property = byId.get(question.propertyId);
    return property && canAsk(property.type) ? [{ question, property }] : [];
  });
}

export interface SubmissionError {
  /** The question it's about; null for the response as a whole. */
  propertyId: string | null;
  message: string;
}

export type Submission =
  | { ok: true; title: string; values: Record<string, unknown> }
  | { ok: false; errors: SubmissionError[] };

export interface SubmissionOptions {
  /** Who person questions may name; without it, person questions can't be answered. */
  members?: ReadonlySet<string>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d\s().-]{3,40}$/;

const isBlank = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/**
 * Check a response (answers by property id) against the form: only its questions,
 * required ones answered, each answer valid for its property. Returns the row's title
 * and stored values, or what's wrong.
 */
export function validateSubmission(
  properties: readonly Property[],
  form: FormConfig,
  answers: Readonly<Record<string, unknown>>,
  options: SubmissionOptions = {},
): Submission {
  const errors: SubmissionError[] = [];
  const asked = formQuestions(properties, form);
  const askedIds = new Set(asked.map((q) => q.property.id));
  for (const key of Object.keys(answers)) {
    if (!askedIds.has(key))
      errors.push({ propertyId: key, message: 'Not a question of this form' });
  }
  let title = '';
  const values: Record<string, unknown> = {};
  for (const { question, property } of asked) {
    const answer = answers[property.id];
    // A required checkbox must be ticked; other answers must be there.
    const missing = property.type === 'checkbox' ? answer !== true : isBlank(answer);
    if (missing) {
      if (question.required) errors.push({ propertyId: property.id, message: 'Required' });
      continue;
    }
    const value = checkAnswer(property, answer, options);
    if (typeof value === 'object' && value !== null && 'error' in value) {
      errors.push({ propertyId: property.id, message: String(value.error) });
    } else if (property.id === TITLE_PROPERTY_ID || property.type === 'title') {
      title = value as string;
    } else {
      values[property.id] = value;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, title, values };
}

/** An answer as its property stores it, or what's wrong with it. */
function checkAnswer(
  property: Property,
  answer: unknown,
  options: SubmissionOptions,
): unknown | { error: string } {
  const text = () => {
    if (typeof answer !== 'string') return { error: 'Expected text' };
    if (answer.length > MAX_ANSWER_LENGTH) return { error: 'Too long' };
    return answer.trim();
  };
  const optionIds = new Set((property.config.options ?? []).map((o) => o.id));
  switch (property.type) {
    case 'title':
    case 'text':
      return text();
    case 'url': {
      const value = text();
      if (typeof value !== 'string') return value;
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
      } catch {
        return { error: 'Not a web address' };
      }
      return value;
    }
    case 'email': {
      const value = text();
      return typeof value !== 'string' || EMAIL_RE.test(value)
        ? value
        : { error: 'Not an email address' };
    }
    case 'phone': {
      const value = text();
      return typeof value !== 'string' || PHONE_RE.test(value)
        ? value
        : { error: 'Not a phone number' };
    }
    case 'number':
      return typeof answer === 'number' && Number.isFinite(answer)
        ? answer
        : { error: 'Expected a number' };
    case 'checkbox':
      return answer === true;
    case 'select':
    case 'status':
      return typeof answer === 'string' && optionIds.has(answer)
        ? answer
        : { error: 'Not one of the options' };
    case 'multiSelect': {
      if (!Array.isArray(answer) || answer.some((id) => !optionIds.has(id as string))) {
        return { error: 'Not one of the options' };
      }
      return [...new Set(answer as string[])];
    }
    case 'date': {
      const start = typeof answer === 'string' ? answer : (answer as DateValue | null)?.start;
      if (typeof start !== 'string' || !DATE_RE.test(start)) return { error: 'Not a date' };
      return { start } satisfies DateValue;
    }
    case 'person': {
      const { members } = options;
      if (!members) return { error: 'People can’t be chosen here' };
      if (!Array.isArray(answer) || answer.some((id) => !members.has(id as string))) {
        return { error: 'Not someone in this workspace' };
      }
      return [...new Set(answer as string[])];
    }
    default:
      return { error: 'Can’t be asked' };
  }
}

/**
 * Answers from an HTML form post (every field is text; repeated fields are lists):
 * numbers parsed, checkboxes ticked when present, multi-selects as lists. Fields that
 * aren't questions are kept, so `validateSubmission` refuses them.
 */
export function answersFromFields(
  properties: readonly Property[],
  form: FormConfig,
  fields: Readonly<Record<string, string | string[]>>,
): Record<string, unknown> {
  const types = new Map(
    formQuestions(properties, form).map((q) => [q.property.id, q.property.type]),
  );
  const answers: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const type = types.get(key);
    const list = Array.isArray(raw) ? raw : [raw];
    const one = list[0] ?? '';
    if (type === 'checkbox') answers[key] = one !== '';
    else if (type === 'multiSelect') answers[key] = list.filter((v) => v !== '');
    else if (type === 'number') answers[key] = one.trim() === '' ? null : Number(one);
    else answers[key] = Array.isArray(raw) && type === undefined ? raw : one;
  }
  return answers;
}
