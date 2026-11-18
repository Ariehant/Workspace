import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  addOption,
  addProperty,
  addView,
  answersFromFields,
  canAsk,
  defaultForm,
  formQuestions,
  initDatabase,
  readDatabase,
  shownQuestions,
  validateSubmission,
  type FormConfig,
} from './index';

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  const id = (name: string, type: Parameters<typeof addProperty>[1]['type']) =>
    addProperty(doc, { name, type });
  const ids = {
    notes: id('Notes', 'text'),
    qty: id('Quantity', 'number'),
    size: id('Size', 'select'),
    tags: readDatabase(doc).properties.find((p) => p.name === 'Tags')!.id,
    due: id('Due', 'date'),
    ok: id('Agree', 'checkbox'),
    site: id('Site', 'url'),
    mail: id('Email', 'email'),
    phone: id('Phone', 'phone'),
    who: id('Owner', 'person'),
    sum: id('Total', 'formula'),
    files: id('Files', 'files'),
  };
  addOption(doc, ids.size, { id: 's', name: 'Small', color: 'blue' });
  addOption(doc, ids.size, { id: 'l', name: 'Large', color: 'red' });
  addOption(doc, ids.tags, { id: 't1', name: 'Urgent', color: 'red' });
  addOption(doc, ids.tags, { id: 't2', name: 'Later', color: 'gray' });
  return { doc, ids, properties: readDatabase(doc).properties };
}

describe('forms', () => {
  it('a new form view asks every askable property, title first', () => {
    const { doc, ids } = setup();
    const viewId = addView(doc, { viewSet: 'db', name: 'Form', type: 'form' });
    const view = readDatabase(doc).views.find((v) => v.id === viewId)!;
    const asked = view.form.questions.map((q) => q.propertyId);
    expect(asked[0]).toBe(TITLE_PROPERTY_ID);
    expect(asked).toContain(ids.who);
    expect(asked).not.toContain(ids.sum);
    expect(asked).not.toContain(ids.files);
    expect(canAsk('rollup')).toBe(false);
    expect(canAsk('files')).toBe(true);
    // Other views read the default form settings.
    expect(readDatabase(doc).views[0]!.form.questions).toEqual([]);
  });

  it('turns valid answers into a title and stored values', () => {
    const { properties, ids } = setup();
    const form = defaultForm(properties);
    const result = validateSubmission(
      properties,
      form,
      {
        [TITLE_PROPERTY_ID]: '  New bearing  ',
        [ids.notes]: 'Ceramic',
        [ids.qty]: 4,
        [ids.size]: 's',
        [ids.tags]: ['t1', 't1', 't2'],
        [ids.due]: '2026-11-02',
        [ids.ok]: true,
        [ids.site]: 'https://lab.io/parts',
        [ids.mail]: 'ada@lab.io',
        [ids.phone]: '+44 20 7946 0000',
        [ids.who]: ['u-ada'],
      },
      { members: new Set(['u-ada']) },
    );
    expect(result).toEqual({
      ok: true,
      title: 'New bearing',
      values: {
        [ids.notes]: 'Ceramic',
        [ids.qty]: 4,
        [ids.size]: 's',
        [ids.tags]: ['t1', 't2'],
        [ids.due]: { start: '2026-11-02' },
        [ids.ok]: true,
        [ids.site]: 'https://lab.io/parts',
        [ids.mail]: 'ada@lab.io',
        [ids.phone]: '+44 20 7946 0000',
        [ids.who]: ['u-ada'],
      },
    });
  });

  it('refuses wrong answers, missing required ones, and anything not asked', () => {
    const { properties, ids } = setup();
    const form: FormConfig = {
      ...defaultForm(properties),
      questions: defaultForm(properties).questions.map((q) => ({
        ...q,
        required: q.propertyId === TITLE_PROPERTY_ID || q.propertyId === ids.ok,
      })),
    };
    const result = validateSubmission(properties, form, {
      [ids.qty]: 'four',
      [ids.size]: 'medium',
      [ids.tags]: ['t1', 'nope'],
      [ids.due]: 'next week',
      [ids.site]: 'javascript:alert(1)',
      [ids.mail]: 'not-an-email',
      [ids.phone]: 'call me',
      [ids.notes]: 'x'.repeat(2001),
      [ids.who]: ['u-ada'],
      [ids.sum]: 12,
      sneaky: 'value',
    });
    expect(result.ok).toBe(false);
    const errors = !result.ok
      ? Object.fromEntries(result.errors.map((e) => [e.propertyId, e.message]))
      : {};
    expect(errors).toEqual({
      [TITLE_PROPERTY_ID]: 'Required',
      [ids.ok]: 'Required',
      [ids.qty]: 'Expected a number',
      [ids.size]: 'Not one of the options',
      [ids.tags]: 'Not one of the options',
      [ids.due]: 'Not a date',
      [ids.site]: 'Not a web address',
      [ids.mail]: 'Not an email address',
      [ids.phone]: 'Not a phone number',
      [ids.notes]: 'Too long',
      [ids.who]: 'People can’t be chosen here',
      [ids.sum]: 'Not a question of this form',
      sneaky: 'Not a question of this form',
    });
  });

  it('only asks what the form asks; deleted properties drop out', () => {
    const { properties, ids } = setup();
    const form: FormConfig = {
      ...defaultForm(properties),
      questions: [
        { propertyId: TITLE_PROPERTY_ID, label: 'Part', description: '', required: true },
        { propertyId: 'gone', label: '', description: '', required: true },
      ],
    };
    expect(formQuestions(properties, form).map((q) => q.question.label)).toEqual(['Part']);
    expect(validateSubmission(properties, form, { [TITLE_PROPERTY_ID]: 'Gear' })).toMatchObject({
      ok: true,
    });
    expect(validateSubmission(properties, form, { [ids.notes]: 'x' }).ok).toBe(false);
  });

  it('reads answers from an HTML form post', () => {
    const { properties, ids } = setup();
    const form = defaultForm(properties);
    const answers = answersFromFields(properties, form, {
      [TITLE_PROPERTY_ID]: 'Gear',
      [ids.qty]: '12',
      [ids.ok]: 'on',
      [ids.tags]: ['t1', 't2'],
      [ids.notes]: '',
    });
    expect(answers).toEqual({
      [TITLE_PROPERTY_ID]: 'Gear',
      [ids.qty]: 12,
      [ids.ok]: true,
      [ids.tags]: ['t1', 't2'],
      [ids.notes]: '',
    });
    expect(validateSubmission(properties, form, answers)).toMatchObject({
      ok: true,
      title: 'Gear',
      values: { [ids.qty]: 12, [ids.ok]: true, [ids.tags]: ['t1', 't2'] },
    });
  });

  it('shows a question only when an earlier answer meets its condition', () => {
    const { properties, ids } = setup();
    const form: FormConfig = {
      ...defaultForm(properties),
      questions: [
        { propertyId: TITLE_PROPERTY_ID, label: '', description: '', required: true },
        { propertyId: ids.size, label: '', description: '', required: false },
        {
          propertyId: ids.notes,
          label: 'Why large?',
          description: '',
          required: true,
          showIf: { propertyId: ids.size, values: ['l'] },
        },
        { propertyId: ids.ok, label: '', description: '', required: false },
        {
          propertyId: ids.mail,
          label: '',
          description: '',
          required: true,
          showIf: { propertyId: ids.ok, values: true },
        },
        // Chained: only when "Why large?" is shown.
        {
          propertyId: ids.qty,
          label: '',
          description: '',
          required: true,
          showIf: { propertyId: ids.notes, values: ['never'] },
        },
      ],
    };
    const shown = (answers: Record<string, unknown>) =>
      [...shownQuestions(properties, form, answers)].map(
        (id) => properties.find((p) => p.id === id)!.name,
      );
    expect(shown({})).toEqual(['Name', 'Size', 'Agree']);
    expect(shown({ [ids.size]: 'l', [ids.ok]: true })).toEqual([
      'Name',
      'Size',
      'Notes',
      'Agree',
      'Email',
    ]);
    // A condition about a question that isn't asked before it doesn't apply.
    const moved: FormConfig = { ...form, questions: [...form.questions].reverse() };
    expect(shownQuestions(properties, moved, {}).size).toBe(6);
    // Hidden questions aren't required, and what's sent for them is dropped.
    const small = validateSubmission(properties, form, {
      [TITLE_PROPERTY_ID]: 'Order',
      [ids.size]: 's',
      [ids.notes]: 'ignored',
    });
    expect(small).toEqual({ ok: true, title: 'Order', values: { [ids.size]: 's' } });
    const large = validateSubmission(properties, form, {
      [TITLE_PROPERTY_ID]: 'Order',
      [ids.size]: 'l',
    });
    expect(large).toMatchObject({ ok: false, errors: [{ propertyId: ids.notes }] });
  });

  it('takes files only from those given for the response', () => {
    const { properties, ids } = setup();
    const form: FormConfig = {
      ...defaultForm(properties),
      questions: [{ propertyId: ids.files, label: '', description: '', required: true }],
    };
    const ok = 'a'.repeat(64) + '.png';
    const files = (id: string) => id === ok;
    expect(
      validateSubmission(
        properties,
        form,
        { [ids.files]: [{ id: ok, name: 'shot.png' }] },
        { files },
      ),
    ).toEqual({ ok: true, title: '', values: { [ids.files]: [{ id: ok, name: 'shot.png' }] } });
    // Not given for it, too many, or no files allowed here.
    expect(
      validateSubmission(
        properties,
        form,
        { [ids.files]: [{ id: 'b'.repeat(64), name: 'x' }] },
        { files },
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateSubmission(
        properties,
        form,
        { [ids.files]: Array.from({ length: 6 }, () => ({ id: ok, name: 'x' })) },
        { files },
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateSubmission(properties, form, { [ids.files]: [{ id: ok, name: 'x' }] }),
    ).toMatchObject({ ok: false });
  });
});
