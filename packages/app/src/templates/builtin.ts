import { readDatabase, type PageBundle } from '@workspace/database';
import { appendContent, type ContentPart } from '@workspace/editor';
import { TemplateBuilder, day } from './build';

export const TEMPLATE_CATEGORIES = ['Personal', 'Projects', 'Engineering', 'Robotics lab'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface BuiltinTemplate {
  id: string;
  name: string;
  icon: string;
  category: TemplateCategory;
  description: string;
  build(): Promise<PageBundle>;
}

const database = (pageId: string) => ({ type: 'database', attrs: { pageId } });
const pageLink = (pageId: string) => ({ type: 'pageLink', attrs: { pageId } });

const STATUS = ['Not started', 'In progress', 'Done'];

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  // --- Personal ------------------------------------------------------------------------
  {
    id: 'reading-list',
    name: 'Reading list',
    icon: '📚',
    category: 'Personal',
    description: 'Books, papers and articles to read, with a board by status.',
    build() {
      const t = new TemplateBuilder();
      const id = t.database({
        title: 'Reading list',
        icon: '📚',
        properties: [
          { name: 'Author', type: 'text' },
          { name: 'Type', type: 'select', options: ['Book', 'Paper', 'Article'] },
          { name: 'Status', type: 'select', options: ['To read', 'Reading', 'Finished'] },
          { name: 'Rating', type: 'select', options: ['★★★★★', '★★★★', '★★★', '★★', '★'] },
          { name: 'Link', type: 'url' },
        ],
        rows: [
          {
            Name: 'Probabilistic Robotics',
            Author: 'Thrun, Burgard, Fox',
            Type: 'Book',
            Status: 'Reading',
          },
          {
            Name: 'Modern Robotics',
            Author: 'Lynch, Park',
            Type: 'Book',
            Status: 'Finished',
            Rating: '★★★★★',
          },
          {
            Name: 'Diffusion Policy',
            Author: 'Chi et al.',
            Type: 'Paper',
            Status: 'To read',
            Link: 'https://arxiv.org/abs/2303.04137',
          },
          { Name: 'The Design of Everyday Things', Author: 'Norman', Type: 'Book' },
        ],
        views: [{ name: 'By status', type: 'board', by: 'Status' }],
      });
      return t.bundle(id);
    },
  },
  {
    id: 'habit-tracker',
    name: 'Habit tracker',
    icon: '✅',
    category: 'Personal',
    description: 'One row per day with a checkbox per habit, and a calendar.',
    build() {
      const t = new TemplateBuilder();
      const id = t.database({
        title: 'Habit tracker',
        icon: '✅',
        titleName: 'Day',
        properties: [
          { name: 'Date', type: 'date' },
          { name: 'Exercise', type: 'checkbox' },
          { name: 'Read', type: 'checkbox' },
          { name: 'Deep work', type: 'checkbox' },
          { name: 'Notes', type: 'text' },
        ],
        rows: [-3, -2, -1, 0].map((offset) => ({
          Day: offset === 0 ? 'Today' : `${-offset} day${offset === -1 ? '' : 's'} ago`,
          Date: day(offset),
          Exercise: String(offset % 2 === 0),
          Read: 'true',
          'Deep work': String(offset !== -2),
        })),
        views: [{ name: 'Calendar', type: 'calendar', by: 'Date' }],
      });
      return t.bundle(id);
    },
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    icon: '🗓️',
    category: 'Personal',
    description: 'Look back at the week and plan the next one.',
    build() {
      const t = new TemplateBuilder();
      const id = t.page({
        title: 'Weekly review',
        icon: '🗓️',
        content: [
          '## What went well\n\n- \n\n## What didn’t\n\n- \n\n## Lessons\n\n- ',
          '## Next week\n\n- [ ] Top priority\n- [ ] Second priority\n- [ ] Something to drop',
          '## Energy and focus\n\nHow did the week feel? What would make next week better?',
        ],
      });
      return t.bundle(id);
    },
  },

  // --- Projects ------------------------------------------------------------------------
  {
    id: 'tasks-projects',
    name: 'Tasks and projects',
    icon: '🎯',
    category: 'Projects',
    description: 'Projects with their tasks, related both ways, with a board and timeline.',
    async build() {
      const t = new TemplateBuilder();
      const root = t.page({
        title: 'Tasks and projects',
        icon: '🎯',
        content: ['Projects group the tasks that move them forward. Open a task to add notes.'],
      });
      const projects = t.database(
        {
          title: 'Projects',
          icon: '📁',
          properties: [
            { name: 'Status', type: 'select', options: ['Planning', 'Active', 'Done'] },
            { name: 'Start', type: 'date' },
            { name: 'End', type: 'date' },
          ],
          rows: [
            { Name: 'Gripper v2', Status: 'Active', Start: day(-14), End: day(21) },
            { Name: 'Lab website', Status: 'Planning', Start: day(7), End: day(30) },
          ],
          views: [{ name: 'Timeline', type: 'timeline', by: 'Start', until: 'End' }],
        },
        root,
      );
      const tasks = t.database(
        {
          title: 'Tasks',
          icon: '☑️',
          properties: [
            { name: 'Status', type: 'select', options: STATUS },
            { name: 'Priority', type: 'select', options: ['High', 'Medium', 'Low'] },
            { name: 'Due', type: 'date' },
          ],
          rows: [
            { Name: 'Pick finger material', Status: 'Done', Priority: 'High', Due: day(-3) },
            { Name: 'Print test fingers', Status: 'In progress', Priority: 'High', Due: day(2) },
            { Name: 'Grip force test', Status: 'Not started', Priority: 'Medium', Due: day(9) },
            { Name: 'Draft site outline', Status: 'Not started', Priority: 'Low', Due: day(10) },
          ],
          views: [{ name: 'Board', type: 'board', by: 'Status' }],
        },
        root,
      );
      const { propertyId } = t.relate(
        { databaseId: tasks, name: 'Project' },
        { databaseId: projects, name: 'Tasks' },
      );
      const rows = (db: string) => new Map(readRows(t, db).map((r) => [r.title, r.id]));
      const p = rows(projects);
      const tk = rows(tasks);
      for (const [task, project] of [
        ['Pick finger material', 'Gripper v2'],
        ['Print test fingers', 'Gripper v2'],
        ['Grip force test', 'Gripper v2'],
        ['Draft site outline', 'Lab website'],
      ] as const) {
        t.link(tasks, tk.get(task)!, propertyId, [p.get(project)!]);
      }
      t.rowContent(tk.get('Grip force test')!, [
        '## Setup\n\n- Load cell under the fingertip\n- 10 grasps per material\n\n## Results\n\n',
      ]);
      appendTo(t, root, [database(projects), database(tasks)]);
      return t.bundle(root);
    },
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    icon: '📝',
    category: 'Projects',
    description: 'Agenda, notes, decisions and action items.',
    build() {
      const t = new TemplateBuilder();
      const id = t.page({
        title: 'Meeting notes',
        icon: '📝',
        content: [
          `**Date:** ${day(0)}  \n**Attendees:** `,
          '## Agenda\n\n1. Updates\n2. Blockers\n3. Next steps',
          '## Notes\n\n- ',
          '## Decisions\n\n> Write down what was decided, and why.',
          '## Action items\n\n- [ ] Owner — task — due date',
        ],
      });
      return t.bundle(id);
    },
  },
  {
    id: 'crm',
    name: 'Contacts (CRM)',
    icon: '🤝',
    category: 'Projects',
    description: 'People and companies you work with, and where each lead stands.',
    build() {
      const t = new TemplateBuilder();
      const id = t.database({
        title: 'Contacts',
        icon: '🤝',
        properties: [
          { name: 'Company', type: 'text' },
          {
            name: 'Stage',
            type: 'select',
            options: ['Lead', 'Contacted', 'Meeting', 'Customer', 'Lost'],
          },
          { name: 'Email', type: 'email' },
          { name: 'Last contact', type: 'date' },
        ],
        rows: [
          {
            Name: 'Ada Park',
            Company: 'Motion Labs',
            Stage: 'Meeting',
            Email: 'ada@example.com',
            'Last contact': day(-2),
          },
          {
            Name: 'Leo Martin',
            Company: 'Servo Works',
            Stage: 'Lead',
            Email: 'leo@example.com',
          },
          {
            Name: 'Sara Ito',
            Company: 'Field Robotics',
            Stage: 'Customer',
            'Last contact': day(-20),
          },
        ],
        views: [{ name: 'Pipeline', type: 'board', by: 'Stage' }],
      });
      return t.bundle(id);
    },
  },
  {
    id: 'content-calendar',
    name: 'Content calendar',
    icon: '📣',
    category: 'Projects',
    description: 'Posts and videos by publish date and channel.',
    build() {
      const t = new TemplateBuilder();
      const id = t.database({
        title: 'Content calendar',
        icon: '📣',
        properties: [
          { name: 'Publish date', type: 'date' },
          { name: 'Channel', type: 'select', options: ['Blog', 'Video', 'Newsletter', 'Social'] },
          {
            name: 'Status',
            type: 'select',
            options: ['Idea', 'Drafting', 'Scheduled', 'Published'],
          },
        ],
        rows: [
          {
            Name: 'Gripper v2 teaser',
            'Publish date': day(3),
            Channel: 'Video',
            Status: 'Drafting',
          },
          {
            Name: 'Monthly update',
            'Publish date': day(10),
            Channel: 'Newsletter',
            Status: 'Idea',
          },
          {
            Name: 'How we test grasps',
            'Publish date': day(-5),
            Channel: 'Blog',
            Status: 'Published',
          },
        ],
        views: [
          { name: 'Calendar', type: 'calendar', by: 'Publish date' },
          { name: 'By status', type: 'board', by: 'Status' },
        ],
      });
      return t.bundle(id);
    },
  },

  // --- Engineering ---------------------------------------------------------------------
  {
    id: 'design-doc',
    name: 'Design doc',
    icon: '📐',
    category: 'Engineering',
    description: 'Context, goals, the proposed design, alternatives and risks.',
    build() {
      const t = new TemplateBuilder();
      const id = t.page({
        title: 'Design doc',
        icon: '📐',
        content: [
          '**Status:** Draft  \n**Author:**   \n**Reviewers:** ',
          '## Context\n\nWhat problem does this solve, and for whom?',
          '## Goals and non-goals\n\n- Goal: \n- Non-goal: ',
          '## Design\n\nHow it works. Diagrams, interfaces, data flow.',
          '```text\nsensor → driver → estimator → planner → controller → actuator\n```',
          '## Alternatives considered\n\n| Option | Pros | Cons |\n| --- | --- | --- |\n|  |  |  |',
          '## Risks and open questions\n\n- [ ] ',
          '## Rollout and testing\n\n',
        ],
      });
      return t.bundle(id);
    },
  },

  // --- Robotics lab --------------------------------------------------------------------
  {
    id: 'experiment-log',
    name: 'Experiment log',
    icon: '🧪',
    category: 'Robotics lab',
    description: 'A protocol page and a log of runs with robot, result and parameters.',
    build() {
      const t = new TemplateBuilder();
      const root = t.page({
        title: 'Experiment log',
        icon: '🧪',
        content: [
          '## Hypothesis\n\nWhat do we expect, and what would prove it wrong?',
          '## Protocol\n\n1. Calibrate sensors\n2. Run the trial set\n3. Log every run below, including failures',
        ],
      });
      const runs = t.database(
        {
          title: 'Runs',
          icon: '🤖',
          titleName: 'Run',
          properties: [
            { name: 'Date', type: 'date' },
            { name: 'Robot', type: 'select', options: ['Arm A', 'Arm B', 'Mobile base'] },
            { name: 'Result', type: 'select', options: ['Pass', 'Fail', 'Inconclusive'] },
            { name: 'Payload (kg)', type: 'number' },
            { name: 'Notes', type: 'text' },
          ],
          rows: [
            {
              Run: 'Run 1',
              Date: day(-1),
              Robot: 'Arm A',
              Result: 'Pass',
              'Payload (kg)': '0.5',
            },
            {
              Run: 'Run 2',
              Date: day(-1),
              Robot: 'Arm A',
              Result: 'Fail',
              'Payload (kg)': '1.2',
              Notes: 'Slipped at 80% grip',
            },
            { Run: 'Run 3', Date: day(0), Robot: 'Arm B', Result: 'Pass', 'Payload (kg)': '1.2' },
          ],
          views: [{ name: 'By result', type: 'board', by: 'Result' }],
        },
        root,
      );
      const notes = t.page({
        title: 'Setup and calibration',
        icon: '🔧',
        parentId: root,
        content: [
          '- Firmware version: \n- Camera intrinsics file: \n- Force/torque sensor zeroed: yes / no',
        ],
      });
      appendTo(t, root, ['## Runs', database(runs), pageLink(notes)]);
      return t.bundle(root);
    },
  },
];

const readRows = (t: TemplateBuilder, databaseId: string) => readDatabase(t.doc(databaseId)).rows;

function appendTo(t: TemplateBuilder, pageId: string, parts: ContentPart[]) {
  appendContent(t.doc(pageId), parts);
}
