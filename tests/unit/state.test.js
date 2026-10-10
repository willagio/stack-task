'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../../state.js');

function texts(list) { return list.map(t => t.text); }

test('push/pop is LIFO within a category', () => {
    const s = State.createState();
    State.push(s, 'a'); State.push(s, 'b'); State.push(s, 'c');
    assert.equal(State.pop(s).task.text, 'c');
    assert.equal(State.pop(s).task.text, 'b');
    assert.deepEqual(texts(s.tasks), ['a']);
    assert.deepEqual(texts(s.completed), ['b', 'c']);
    assert.ok(s.completed[0].completedAt);
});

test('pop acts on the current category, not the global top', () => {
    const s = State.createState();
    State.push(s, 'work-1');
    State.switchCategory(s, 'Personal');
    State.push(s, 'personal-1');
    State.switchCategory(s, 'Work');
    State.push(s, 'work-2');
    State.switchCategory(s, 'Personal');
    State.push(s, 'personal-2'); // globally last
    State.switchCategory(s, 'Work');

    assert.equal(State.pop(s).task.text, 'work-2');
    assert.deepEqual(texts(s.tasks), ['work-1', 'personal-1', 'personal-2']);
    assert.equal(State.pop(s).task.text, 'work-1');
    assert.equal(State.pop(s).ok, false, 'Work is empty; Personal tasks must not be popped');
    assert.deepEqual(texts(s.tasks), ['personal-1', 'personal-2']);
});

test('push rejects empty and over-long text', () => {
    const s = State.createState();
    assert.equal(State.push(s, '   ').ok, false);
    assert.equal(State.push(s, 'x'.repeat(State.MAX_TASK_LENGTH + 1)).ok, false);
    assert.equal(State.push(s, 'x'.repeat(State.MAX_TASK_LENGTH)).ok, true);
    assert.equal(State.push(s, '  padded  ').task.text, 'padded');
});

test('ids are unique even when created in the same millisecond', () => {
    const s = State.createState();
    for (let i = 0; i < 500; i++) State.push(s, 'task ' + i);
    assert.equal(new Set(s.tasks.map(t => String(t.id))).size, 500);
});

test('archive / restore / delete', () => {
    const s = State.createState();
    State.push(s, 'a'); State.push(s, 'b');
    const idA = s.tasks[0].id;
    assert.equal(State.archiveTask(s, idA).ok, true);
    assert.deepEqual(texts(s.tasks), ['b']);
    assert.ok(s.archived[0].archivedAt);
    State.restoreArchived(s, idA);
    assert.deepEqual(texts(s.tasks), ['a', 'b'], 'restored task goes to the bottom');
    assert.equal('archivedAt' in s.tasks[0], false);
    State.archiveTask(s, idA);
    assert.equal(State.deleteArchived(s, idA).ok, true);
    assert.equal(s.archived.length, 0);
    assert.equal(State.removeTask(s, 'nope').ok, false);
    assert.equal(State.removeTask(s, s.tasks[0].id).ok, true);
    assert.equal(s.tasks.length, 0);
});

test('complete / restore / delete completed', () => {
    const s = State.createState();
    State.push(s, 'a');
    const done = State.pop(s).task;
    State.restoreCompleted(s, done.id);
    assert.deepEqual(texts(s.tasks), ['a']);
    assert.equal('completedAt' in s.tasks[0], false);
    State.pop(s);
    assert.equal(State.deleteCompleted(s, done.id).ok, true);
    assert.equal(s.completed.length, 0);
});

test('numeric (legacy) ids are matched by their string form', () => {
    const s = State.createState({ tasks: [{ text: 'a', id: 1700000000001, category: 'Work' }] });
    assert.equal(State.archiveTask(s, '1700000000001').ok, true);
});

test('reorderTasks: dropping above/below the target', () => {
    const mk = () => State.createState({ tasks: ['a', 'b', 'c', 'd'].map(t => ({ text: t, id: t, category: 'Work' })) });
    // Display is top-first, so "above" = higher array index
    let s = mk(); State.reorderTasks(s, 'a', 'c', true);
    assert.deepEqual(texts(s.tasks), ['b', 'c', 'a', 'd']);
    s = mk(); State.reorderTasks(s, 'a', 'c', false);
    assert.deepEqual(texts(s.tasks), ['b', 'a', 'c', 'd']);
    s = mk(); State.reorderTasks(s, 'd', 'b', true);
    assert.deepEqual(texts(s.tasks), ['a', 'b', 'd', 'c']);
    s = mk(); State.reorderTasks(s, 'd', 'b', false);
    assert.deepEqual(texts(s.tasks), ['a', 'd', 'b', 'c']);
    assert.equal(State.reorderTasks(s, 'a', 'a', true).ok, false);
});

test('reorder keeps relative order inside a category when categories are mixed', () => {
    const s = State.createState({ tasks: [
        { text: 'w1', id: 1, category: 'Work' }, { text: 'p1', id: 2, category: 'Personal' },
        { text: 'w2', id: 3, category: 'Work' }, { text: 'p2', id: 4, category: 'Personal' },
        { text: 'w3', id: 5, category: 'Work' }
    ] });
    State.reorderTasks(s, 1, 5, true); // move w1 above w3 (to the top of Work)
    assert.deepEqual(texts(State.inCategory(s.tasks, 'Work')), ['w2', 'w3', 'w1']);
    assert.deepEqual(texts(State.inCategory(s.tasks, 'Personal')), ['p1', 'p2']);
});

test('categories: create, case-insensitive duplicates, limits', () => {
    const s = State.createState();
    assert.equal(State.createCategory(s, 'work').ok, false);
    assert.equal(State.createCategory(s, '  PERSONAL ').ok, false);
    assert.equal(State.createCategory(s, '   ').ok, false);
    assert.equal(State.createCategory(s, 'x'.repeat(State.MAX_CATEGORY_LENGTH + 1)).ok, false);
    const r = State.createCategory(s, ' Ideas ');
    assert.equal(r.ok, true);
    assert.deepEqual(s.categories, ['Work', 'Personal', 'Ideas']);
    assert.equal(s.currentCategory, 'Ideas');
});

test('rename category moves its tasks; case-only rename is allowed', () => {
    const s = State.createState();
    State.push(s, 'a'); State.pop(s); State.push(s, 'b');
    assert.equal(State.renameCategory(s, 'Work', 'personal').ok, false);
    assert.equal(State.renameCategory(s, 'Work', 'WORK').ok, true);
    assert.equal(s.currentCategory, 'WORK');
    assert.ok(s.tasks.every(t => t.category === 'WORK'));
    assert.ok(s.completed.every(t => t.category === 'WORK'));
});

test('delete category removes its tasks; last category is protected', () => {
    const s = State.createState();
    State.push(s, 'w'); State.switchCategory(s, 'Personal'); State.push(s, 'p');
    assert.equal(State.countInCategory(s, 'Personal'), 1);
    assert.equal(State.deleteCategory(s, 'Personal').ok, true);
    assert.deepEqual(texts(s.tasks), ['w']);
    assert.equal(s.currentCategory, 'Work');
    const r = State.deleteCategory(s, 'Work');
    assert.equal(r.ok, false);
    assert.match(r.error, /last category/);
});

test('reorderCategories', () => {
    const s = State.createState({ categories: ['A', 'B', 'C'] });
    State.reorderCategories(s, 'A', 'C', false);
    assert.deepEqual(s.categories, ['B', 'C', 'A']);
    State.reorderCategories(s, 'A', 'B', true);
    assert.deepEqual(s.categories, ['A', 'B', 'C']);
});

test('formatTime handles missing and invalid timestamps', () => {
    const now = Date.parse('2024-06-01T12:00:00Z');
    assert.equal(State.formatTime(undefined, now), 'Unknown time');
    assert.equal(State.formatTime(null, now), 'Unknown time');
    assert.equal(State.formatTime('garbage', now), 'Unknown time');
    assert.equal(State.formatTime('2024-06-01T11:59:50Z', now), 'Just now');
    assert.equal(State.formatTime('2024-06-01T11:30:00Z', now), '30m ago');
    assert.equal(State.formatTime('2024-06-01T09:00:00Z', now), '3h ago');
    assert.equal(State.formatTime('2024-05-30T12:00:00Z', now), '2d ago');
    assert.equal(State.formatTime(now - 5 * 60000, now), '5m ago');
});

test('moveTask swaps with the neighbour in the same category only', () => {
    const s = State.createState();
    State.push(s, 'w1');
    State.switchCategory(s, 'Personal'); State.push(s, 'p1');
    State.switchCategory(s, 'Work'); State.push(s, 'w2'); State.push(s, 'w3');
    const id = text => s.tasks.find(t => t.text === text).id;
    assert.equal(State.moveTask(s, id('w3'), 'up').ok, false, 'already on top');
    assert.equal(State.moveTask(s, id('w1'), 'down').ok, false, 'already at the bottom');
    assert.equal(State.moveTask(s, id('w2'), 'up').ok, true);
    assert.deepEqual(texts(State.inCategory(s.tasks, 'Work')), ['w1', 'w3', 'w2']);
    assert.equal(State.moveTask(s, id('w1'), 'up').ok, true, 'skips the Personal task in between');
    assert.deepEqual(texts(State.inCategory(s.tasks, 'Work')), ['w3', 'w1', 'w2']);
    assert.deepEqual(texts(State.inCategory(s.tasks, 'Personal')), ['p1']);
    assert.equal(State.moveTask(s, 'nope', 'up').ok, false);
});

test('positionFromTop counts from the top of the task\'s own category', () => {
    const s = State.createState();
    State.push(s, 'a'); State.push(s, 'b'); State.push(s, 'c');
    const id = text => s.tasks.find(t => t.text === text).id;
    assert.equal(State.positionFromTop(s, id('c')), 1);
    assert.equal(State.positionFromTop(s, id('a')), 3);
    assert.equal(State.positionFromTop(s, 'nope'), 0);
});

test('clone is a deep, independent snapshot', () => {
    const s = State.createState();
    State.push(s, 'a');
    State.switchCategory(s, 'Personal');
    const snapshot = State.clone(s);
    State.pop(s); s.tasks[0].text = 'changed'; s.categories.push('X');
    assert.equal(snapshot.tasks[0].text, 'a');
    assert.deepEqual(snapshot.categories, ['Work', 'Personal']);
    assert.equal(snapshot.currentCategory, 'Personal');
});

test('validateCategoryName is exposed and ignores the category being renamed', () => {
    const s = State.createState();
    assert.equal(State.validateCategoryName(s, 'work', null).ok, false);
    assert.equal(State.validateCategoryName(s, 'work', 'Work').ok, true);
    assert.equal(State.validateCategoryName(s, '  ', null).ok, false);
});
