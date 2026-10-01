import { InputRule } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';

/** To-do list. `[] ` (Notion) as well as `[ ] ` / `[x] ` start one. */
export const TodoList = TaskList.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\[\]\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).toggleTaskList().run();
        },
      }),
    ];
  },
});

export const TodoItem = TaskItem.configure({ nested: true });
