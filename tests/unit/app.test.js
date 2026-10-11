'use strict';
// Runs the real classic scripts (state, storage, ui, render, dnd, app) in the same order as
// index.html, inside a vm context with a fake DOM and no CommonJS `module`, like a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeDocument, buildPage } = require('./fake-dom.js');
const { createLocalStorageStub, XSS } = require('./helpers.js');

const ROOT = path.join(__dirname, '../..');
const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/original-v0.json'), 'utf8'));

function boot(initialStorage, dialogs) {
    const document = new FakeDocument();
    buildPage(document);
    const log = { alerts: [], confirms: [], prompts: [], errors: [], downloads: [], timers: [] };
    const answers = Object.assign({ confirm: true, prompt: null }, dialogs);
    const localStorage = createLocalStorageStub(initialStorage);
    const win = {
        document, localStorage, console: { error: (...a) => log.errors.push(a), log() {}, warn() {} },
        alert: m => log.alerts.push(m),
        confirm: m => { log.confirms.push(m); return typeof answers.confirm === 'function' ? answers.confirm(m) : answers.confirm; },
        prompt: m => { log.prompts.push(m); return typeof answers.prompt === 'function' ? answers.prompt(m) : answers.prompt; },
        // short timers (live-region updates) run at once; long ones (toast auto-hide) are kept pending
        setTimeout: (fn, ms) => { if (!ms || ms <= 100) fn(); else log.timers.push(fn); return log.timers.length; },
        clearTimeout() {},
        addEventListener() {},
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: blob => { log.downloads.push(blob.parts.join('')); return 'blob:x'; }, revokeObjectURL() {} }
    };
    win.window = win;
    vm.createContext(win);
    for (const file of ['state.js', 'storage.js', 'ui.js', 'render.js', 'dnd.js', 'app.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), win, { filename: file });
    }
    const $ = id => document.getElementById(id);
    return { win, document, log, localStorage, $,
        stored: () => JSON.parse(localStorage.getItem('fileDB')),
        add(text) { $('taskInput').value = text; $('taskInput').dispatch('keydown', { key: 'Enter' }); },
        topText: () => { const t = $('taskStack').querySelector('.top-task'); return t && t.querySelector('.task-text').textContent; },
        tab: name => document.querySelectorAll('.tab').find(t => t.dataset.category === name),
        tabButton: name => document.querySelectorAll('.tab-button').find(t => t.dataset.category === name),
        toast: () => ({ text: $('toastMessage').textContent, hidden: $('toast').hidden, canUndo: !$('toastAction').hidden }),
        live: () => $('liveRegion').textContent
    };
}

test('scripts load as classic scripts and render an empty app', () => {
    const app = boot();
    assert.equal(app.$('popButton').disabled, true);
    assert.equal(app.document.querySelectorAll('.tab').length, 2);
    assert.match(app.$('taskStack').textContent, /No tasks in stack/);
    assert.equal(app.localStorage.getItem('fileDB'), null, 'nothing written until the user acts');
});

test('add via Enter, ignoring IME composition and empty input', () => {
    const app = boot();
    app.$('taskInput').value = 'composing';
    app.$('taskInput').dispatch('keydown', { key: 'Enter', isComposing: true });
    app.$('taskInput').dispatch('keydown', { key: 'Enter', keyCode: 229 });
    assert.equal(app.localStorage.getItem('fileDB'), null);
    app.$('taskInput').value = '   ';
    app.$('taskInput').dispatch('keydown', { key: 'Enter' });
    assert.equal(app.localStorage.getItem('fileDB'), null);

    app.$('taskInput').value = 'first';
    app.$('taskInput').dispatch('keydown', { key: 'Enter' });
    assert.equal(app.$('taskInput').value, '', 'input cleared after add');
    assert.equal(app.topText(), 'first');
    assert.equal(app.document.querySelector('.stack-count').textContent, '1');
    assert.equal(app.$('popButton').disabled, false);
    assert.equal(app.stored().tasks.length, 1);
});

test('pop completes the top task of the current category only', () => {
    const app = boot();
    app.add('work-1');
    app.tab('Personal').click();
    app.add('personal-1');
    app.tab('Work').click();
    app.add('work-2');
    app.tab('Personal').click();
    app.add('personal-2');
    app.tab('Work').click();

    app.$('popButton').click();
    assert.equal(app.topText(), 'work-1');
    assert.equal(app.stored().completed[0].text, 'work-2');
    app.$('popButton').click();
    assert.equal(app.$('popButton').disabled, true, 'Work is empty');
    assert.equal(app.stored().tasks.length, 2, 'Personal tasks untouched');
    assert.match(app.$('completedTasks').textContent, /work-2/);
});

test('delete is immediate, undoable, and listeners are registered once', () => {
    const app = boot();
    for (let i = 0; i < 5; i++) app.add('t' + i);
    assert.equal(app.$('taskStack').listenerCount('click'), 1);
    assert.equal(app.$('completedTasks').listenerCount('click'), 1);
    const before = app.stored().tasks.map(t => t.id);
    app.$('taskStack').querySelector('.remove-btn').click(); // top: t4
    assert.equal(app.log.confirms.length, 0, 'no confirm dialog');
    assert.equal(app.stored().tasks.length, 4);
    assert.match(app.toast().text, /Deleted "t4"/);
    assert.equal(app.toast().canUndo, true);
    assert.equal(app.toast().hidden, false);

    app.$('toastAction').click();
    assert.deepEqual(app.stored().tasks.map(t => t.id), before, 'undo restores the exact order');
    assert.equal(app.toast().hidden, true);
    assert.equal(app.topText(), 't4');
});

test('a later action replaces the pending undo; Ctrl+Z and Dismiss work', () => {
    const app = boot();
    app.add('a'); app.add('b');
    app.$('popButton').click();                        // completes b
    assert.match(app.toast().text, /Completed "b"/);
    app.add('c');                                      // any other change retires the old undo
    assert.equal(app.toast().hidden, true);

    app.$('popButton').click();                        // completes c
    app.document.dispatch('keydown', { key: 'z', ctrlKey: true, target: { tagName: 'INPUT' } });
    assert.equal(app.stored().completed.length, 2, 'Ctrl+Z is left to the text field');
    app.document.dispatch('keydown', { key: 'z', ctrlKey: true, target: { tagName: 'BODY' } });
    assert.equal(app.stored().completed.length, 1);
    assert.equal(app.topText(), 'c');
    assert.equal(app.live(), 'Undone.');

    app.$('popButton').click();
    app.$('toastClose').click();
    assert.equal(app.toast().hidden, true);
});

test('move up / down swaps with the neighbour in the same category and announces it', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');          // display: c, b, a
    app.tab('Personal').click(); app.add('p'); app.tab('Work').click();
    const buttons = () => app.$('taskStack').querySelectorAll('.task-item').map(i => ({ up: i.querySelector('.move-up-btn'), down: i.querySelector('.move-down-btn') }));
    assert.equal(buttons()[0].up.disabled, true, 'top task cannot move up');
    assert.equal(buttons()[2].down.disabled, true, 'bottom task cannot move down');
    buttons()[1].up.click();                           // b up -> b, c, a
    assert.deepEqual(app.stored().tasks.filter(t => t.category === 'Work').map(t => t.text), ['a', 'c', 'b']);
    assert.equal(app.topText(), 'b');
    assert.match(app.live(), /Moved "b" up\. Position 1 of 3\./);
    buttons()[0].down.click();                         // b down
    assert.deepEqual(app.stored().tasks.filter(t => t.category === 'Work').map(t => t.text), ['a', 'b', 'c']);
    assert.equal(app.stored().tasks.find(t => t.text === 'p').category, 'Personal');
});

test('keyboard focus follows the moved item and survives re-renders', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');
    const itemOf = text => app.$('taskStack').querySelectorAll('.task-item').find(i => i.querySelector('.task-text').textContent === text);
    itemOf('b').querySelector('.move-up-btn').focus();
    itemOf('b').querySelector('.move-up-btn').click();
    // b is now the top task: its "up" button is disabled and cannot keep focus, so the next enabled one does
    assert.equal(app.document.activeElement.closest('.task-item').dataset.id, itemOf('b').dataset.id);
    assert.equal(app.document.activeElement.disabled, false);
    assert.equal(app.document.activeElement.className.includes('move-down-btn'), true);
    // a middle item keeps focus on the very same button
    itemOf('a').querySelector('.move-up-btn').focus();
    itemOf('a').querySelector('.move-up-btn').click();
    assert.equal(app.document.activeElement.className.includes('move-up-btn'), true);
    assert.equal(app.document.activeElement.closest('.task-item').dataset.id, itemOf('a').dataset.id);
    // deleting an item with the keyboard moves focus to a neighbour instead of dropping it
    itemOf('b').querySelector('.remove-btn').focus();
    itemOf('b').querySelector('.remove-btn').click();
    assert.ok(app.document.activeElement.closest('.task-item'));
});

test('markup contract: tablist roles, aria-selected, labelled icon buttons, counts', () => {
    const app = boot();
    app.add('x');
    const tabs = app.document.querySelectorAll('.tab-button');
    assert.deepEqual(tabs.map(t => t.getAttribute('role')), ['tab', 'tab']);
    assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['true', 'false']);
    assert.deepEqual(tabs.map(t => t.getAttribute('tabindex')), ['0', '-1']);
    assert.equal(app.$('taskPanel').getAttribute('aria-labelledby'), tabs[0].id);
    const icons = app.$('taskStack').querySelectorAll('button');
    assert.ok(icons.length >= 4);
    icons.forEach(b => assert.ok(b.getAttribute('aria-label'), 'icon button has an accessible name'));
    app.document.querySelectorAll('svg').forEach(s => assert.equal(s.getAttribute('aria-hidden'), 'true'));
    app.$('popButton').click();
    assert.equal(app.$('completedCount').textContent, '1');
    assert.equal(app.document.querySelector('.stack-label').textContent, 'tasks');
    app.add('y');
    assert.equal(app.document.querySelector('.stack-label').textContent, 'task');
});

test('tabs: arrow keys switch category, Alt+Arrow reorders it', () => {
    const app = boot();
    const key = (name, props) => { app.tabButton(name).focus(); return app.tabButton(name).dispatch('keydown', { key: props.key, altKey: !!props.altKey }); };
    key('Work', { key: 'ArrowRight' });
    assert.equal(app.stored().currentCategory, 'Personal');
    assert.equal(app.document.activeElement.dataset.category, 'Personal');
    key('Personal', { key: 'ArrowRight' });            // wraps around
    assert.equal(app.stored().currentCategory, 'Work');
    key('Work', { key: 'End' });
    assert.equal(app.stored().currentCategory, 'Personal');
    key('Personal', { key: 'Home' });
    assert.equal(app.stored().currentCategory, 'Work');
    key('Work', { key: 'ArrowRight', altKey: true });
    assert.deepEqual(app.stored().categories, ['Personal', 'Work']);
    assert.equal(app.stored().currentCategory, 'Work', 'moving does not switch');
    assert.match(app.live(), /Moved category "Work" right/);
});

test('archive, restore, complete, restore completed, delete', () => {
    const app = boot();
    app.add('a'); app.add('b');
    app.$('taskStack').querySelector('.archive-btn').click(); // archives top: b
    assert.equal(app.stored().archived[0].text, 'b');
    assert.match(app.$('archivedTasks').textContent, /b/);
    app.$('archivedTasks').querySelector('.restore-btn').click();
    assert.equal(app.stored().tasks.length, 2);
    app.$('popButton').click();
    const done = app.$('completedTasks').querySelector('.restore-completed-btn');
    done.click();
    assert.equal(app.stored().completed.length, 0);
    app.$('popButton').click();
    app.$('completedTasks').querySelector('.delete-completed-btn').click();
    assert.equal(app.stored().completed.length, 0);
    assert.equal(app.stored().archived.length, 0);
});

test('categories: create, duplicate (case-insensitive), switch, rename, delete', async () => {
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const app = boot({}, { prompt: 'Ideas' });
    app.$('addCategoryBtn').click();
    await settle();
    assert.equal(app.stored().currentCategory, 'Ideas');
    assert.equal(app.log.prompts.length, 1, 'no <dialog> in this page: falls back to prompt');
    app.win.prompt = () => 'ideas';
    app.$('addCategoryBtn').click();
    await settle();
    assert.match(app.toast().text, /already exists/);
    assert.equal(app.stored().categories.length, 3);

    app.tab('Work').click();
    assert.equal(app.stored().currentCategory, 'Work');
    app.win.prompt = () => 'Job';
    app.tab('Work').dispatch('dblclick');
    await settle();
    assert.deepEqual(app.stored().categories, ['Job', 'Personal', 'Ideas']);
    app.win.prompt = () => 'Office';
    app.$('renameCategoryBtn').click();
    await settle();
    assert.deepEqual(app.stored().categories, ['Office', 'Personal', 'Ideas']);
    assert.equal(app.log.prompts.at(-1), 'Category name', 'rename button works without double-click');

    app.add('x');
    app.$('deleteCategoryBtn').click();                 // current category: Office
    assert.equal(app.log.confirms.length, 0);
    assert.match(app.toast().text, /Deleted category "Office" and its 1 task\./);
    assert.deepEqual(app.stored().categories, ['Personal', 'Ideas']);
    assert.equal(app.stored().currentCategory, 'Personal');
    app.$('toastAction').click();
    assert.deepEqual(app.stored().categories, ['Office', 'Personal', 'Ideas']);
    assert.equal(app.stored().currentCategory, 'Office');
    assert.equal(app.topText(), 'x', 'its tasks come back with it');
});

test('the last category cannot be deleted', () => {
    const initial = JSON.stringify({ tasks: [], completed: [], archived: [], categories: ['Only'] });
    const app = boot({ fileDB: initial });
    assert.equal(app.$('deleteCategoryBtn').disabled, true);
    app.$('deleteCategoryBtn').click();
    assert.match(app.toast().text, /Cannot delete the last category/);
    assert.equal(app.localStorage.getItem('fileDB'), initial, 'nothing was changed or saved');
});

test('reload restores everything (new app instance on the same storage)', () => {
    const first = boot();
    first.add('keep me'); first.add('and me'); first.$('popButton').click();
    first.tab('Personal').click();
    const second = boot({ fileDB: first.localStorage.getItem('fileDB') });
    assert.equal(second.stored().currentCategory, 'Personal');
    second.tab('Work').click();
    assert.equal(second.topText(), 'keep me');
    assert.match(second.$('completedTasks').textContent, /and me/);
});

test('ORIGINAL fileDB + legacy currentCategory renders and keeps working', () => {
    const app = boot({ fileDB: original.fileDB, currentCategory: 'Personal' });
    assert.equal(app.topText(), 'Buy milk');
    assert.match(app.$('completedTasks').textContent, /Done thing/);
    app.tab('Work').click();
    assert.equal(app.topText(), 'Email "Bob" & <team>');
    app.add('new one');
    assert.equal(app.stored().tasks.length, 4);
    assert.equal(app.stored().tasks[0].id, 1700000000001, 'numeric ids preserved');
    assert.equal(app.localStorage.keys().filter(k => k !== 'fileDB' && k !== 'currentCategory').length, 0);
});

test('legacy keys only (no fileDB) are migrated on startup', () => {
    const app = boot({ ...original.legacy });
    assert.equal(app.topText(), 'Buy milk');
    assert.equal(app.stored().currentCategory, 'Personal');
    assert.equal(app.stored().tasks.length, 3);
});

test('corrupted fileDB: warning shown, raw string preserved', () => {
    const app = boot({ fileDB: '{broken' });
    assert.match(app.toast().text, /backup|corrupt|read/i);
    assert.equal(app.log.alerts.length, 0, 'no blocking alert');
    const backup = app.localStorage.keys().find(k => k.startsWith('fileDB.backup-'));
    assert.equal(app.localStorage.getItem(backup), '{broken');
});

test('malicious data is rendered as text only (innerHTML would throw in the fake DOM)', () => {
    const evil = `${XSS}" onmouseover="alert(1)`;
    const raw = JSON.stringify({
        tasks: [{ text: evil, id: 'x1', category: evil }],
        completed: [{ text: evil, id: 'x2', category: evil }],
        archived: [{ text: evil, id: 'x3', category: evil }],
        categories: [evil], currentCategory: evil
    });
    const app = boot({ fileDB: raw });
    assert.equal(app.topText(), evil);
    assert.equal(app.document.querySelector('.tab-name').textContent, evil);
    assert.equal(app.document.querySelector('.tab').dataset.category, evil);
    assert.equal(app.$('completedTasks').querySelector('.completed-text').textContent, evil);
    assert.equal(app.$('completedTasks').querySelector('.completed-time').textContent, 'Unknown time');
    assert.equal(app.$('archivedTasks').querySelector('.archived-time').textContent, 'Unknown time');
    assert.deepEqual(app.log.errors, []);
});

function importFile(app, text) {
    const input = app.$('importFile');
    input.files = [{ text: async () => text }];
    input.value = 'C:\\fakepath\\f.json';
    const event = input.dispatch('change');
    return new Promise(resolve => setImmediate(resolve)).then(() => event);
}

test('export -> import round trip through the UI', async () => {
    const a = boot();
    a.add('one'); a.add('two'); a.$('popButton').click();
    a.tab('Personal').click(); a.add('three');
    a.$('taskStack').querySelector('.archive-btn').click();
    a.$('exportBtn').click();
    assert.equal(a.log.downloads.length, 1);
    const exported = a.log.downloads[0];

    const b = boot();
    await importFile(b, exported);
    assert.match(b.log.confirms.at(-1), /Replace your current tasks/);
    assert.deepEqual(b.stored(), a.stored());
    assert.equal(b.toast().canUndo, true, 'an import can be undone');
    assert.equal(b.$('importFile').value, '', 'file input reset');
});

test('invalid import is rejected with a message and leaves data untouched', async () => {
    const app = boot();
    app.add('precious');
    const before = app.localStorage.getItem('fileDB');
    for (const bad of ['{nope', '{"tasks": [{"text": "<b>", "id": "\\"><img>"}]}', '[]', '{"completed": []}']) {
        await importFile(app, bad);
        assert.match(app.toast().text, /Import failed/);
        assert.equal(app.toast().hidden, false);
    }
    assert.equal(app.localStorage.getItem('fileDB'), before);
    assert.equal(app.topText(), 'precious');
});

test('declining the import confirmation keeps current data', async () => {
    const app = boot({}, { confirm: false });
    app.add('mine');
    await importFile(app, JSON.stringify({ tasks: [{ text: 'theirs', id: 1, category: 'Work' }] }));
    assert.equal(app.topText(), 'mine');
});

test('import replaces archived and categories too, and they persist', async () => {
    const app = boot();
    app.add('old');
    await importFile(app, JSON.stringify({
        tasks: [{ text: 't', id: 1, category: 'Home' }],
        archived: [{ text: 'arch', id: 2, category: 'Home', archivedAt: '2024-01-01T00:00:00Z' }],
        categories: ['Home']
    }));
    app.add('after import'); // triggers another save from in-memory state
    const stored = app.stored();
    assert.deepEqual(stored.categories, ['Home']);
    assert.equal(stored.archived[0].text, 'arch');
    assert.equal(stored.currentCategory, 'Home');
    assert.equal(stored.tasks.length, 2);
});

test('collapsible sections toggle from a real button and keep aria-expanded in sync', () => {
    const app = boot();
    const section = app.document.querySelector('.archive-section');
    const toggle = section.querySelector('.section-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(section.classList.contains('collapsed'), false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    toggle.click();
    assert.equal(section.classList.contains('collapsed'), true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('pointer drag reorders the stack: rows slide aside, drop above the top row (delegated listeners)', () => {
    const app = boot();
    ['a', 'b', 'c'].forEach(t => app.add(t));
    const stack = app.$('taskStack');
    assert.equal(stack.listenerCount('pointerdown'), 1);
    const [top, middle, bottom] = stack.querySelectorAll('.task-item'); // displayed c, b, a
    // Lay the rows out vertically (the fake DOM has no layout): 56px rows, 8px apart, divider included
    stack.children.forEach((node, i) => { node.getBoundingClientRect = () => ({ top: i * 64, left: 0, width: 300, height: 56 }); });
    bottom.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 50, clientY: 220 });
    bottom.dispatch('pointermove', { pointerId: 1, clientX: 50, clientY: 20 }); // up past the top row
    assert.ok(bottom.classList.contains('dragging'));
    assert.match(top.style.transform, /translateY\(64px\)/);    // the top row moved down to make room
    assert.match(middle.style.transform, /translateY\(64px\)/);
    bottom.dispatch('pointerup', { pointerId: 1, clientX: 50, clientY: 20 });
    assert.deepEqual(app.stored().tasks.map(t => t.text), ['b', 'c', 'a']);
    assert.equal(app.topText(), 'a');
    assert.equal(stack.querySelectorAll('.dragging').length, 0);
    assert.equal(stack.classList.contains('sorting'), false);
});

test('a pointer drag that ends where it started changes nothing and slides back', () => {
    const app = boot();
    ['a', 'b'].forEach(t => app.add(t));
    const stack = app.$('taskStack');
    const [top] = stack.querySelectorAll('.task-item');
    stack.children.forEach((node, i) => { node.getBoundingClientRect = () => ({ top: i * 64, left: 0, width: 300, height: 56 }); });
    top.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 10, clientY: 28 });
    top.dispatch('pointermove', { pointerId: 2, clientX: 10, clientY: 40 });
    assert.ok(top.classList.contains('dragging'));
    top.dispatch('pointerup', { pointerId: 2, clientX: 10, clientY: 40 });
    assert.equal(top.style.transform, '');
    assert.equal(app.topText(), 'b');
    // clicking a button inside a row never starts a drag
    const button = top.querySelector('.archive-btn');
    button.dispatch('pointerdown', { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 10, clientY: 28 });
    button.dispatch('pointermove', { pointerId: 3, clientX: 10, clientY: 200 });
    assert.equal(top.classList.contains('dragging'), false);
});

test('the top card carries Start and Done; lower rows have no number or idle timer', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');
    const top = app.$('taskStack').querySelector('.top-task');
    assert.ok(top.contains(app.$('popButton')), 'Done lives inside the top card');
    assert.equal(app.$('popButton').getAttribute('aria-label'), 'Done: "c"');
    assert.ok(top.querySelector('.now-actions .timer-btn'), 'Start sits beside Done');
    assert.equal(app.$('taskStack').querySelectorAll('.task-index').length, 0);
    assert.equal(app.$('taskStack').querySelectorAll('.task-item').filter(i => i !== top && i.querySelector('.timer-btn')).length, 0);
    // a running timer keeps its pause button and clock on a lower row
    const rowOf = text => app.$('taskStack').querySelectorAll('.task-item').find(i => i.querySelector('.task-text').textContent === text);
    rowOf('c').querySelector('.timer-btn').click();
    rowOf('c').querySelector('.move-down-btn').click();
    assert.equal(rowOf('c').classList.contains('top-task'), false);
    assert.ok(rowOf('c').querySelector('.timer-btn.running'));
    assert.ok(rowOf('c').querySelector('.task-time.running'));
});

test('the Done button returns to the input section when the stack is empty, and focus follows it', () => {
    const app = boot();
    app.add('only');
    app.$('popButton').focus();
    app.$('popButton').click();
    assert.ok(!app.$('taskStack').contains(app.$('popButton')), 'not inside a card any more');
    assert.ok(app.$('popButton').parentNode, 'still in the document');
    assert.equal(app.$('popButton').disabled, true);
    assert.equal(app.document.activeElement, app.$('taskInput'), 'keyboard focus moves on to the input');
    app.$('toastAction').click();                         // Undo
    assert.equal(app.topText(), 'only');
    assert.ok(app.$('taskStack').querySelector('.top-task').contains(app.$('popButton')));
});

test('keyboard focus stays on Done after it completes a task', () => {
    const app = boot();
    app.add('a'); app.add('b');
    app.$('popButton').focus();
    app.$('popButton').click();
    assert.equal(app.topText(), 'a');
    assert.equal(app.document.activeElement, app.$('popButton'));
    assert.ok(app.$('taskStack').querySelector('.top-task').contains(app.$('popButton')));
});

test('clicking a row opens it (one at a time) and it stays open across re-renders', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');
    const row = text => app.$('taskStack').querySelectorAll('.task-item').find(i => i.querySelector('.task-text').textContent === text);
    row('b').querySelector('.task-text').click();
    assert.ok(row('b').classList.contains('open'));
    row('a').querySelector('.task-text').click();
    assert.ok(row('a').classList.contains('open'));
    assert.ok(!row('b').classList.contains('open'), 'only one row open');
    row('a').querySelector('.move-up-btn').click();          // re-renders
    assert.ok(row('a').classList.contains('open'), 'still open after a re-render');
    row('a').querySelector('.task-text').click();
    assert.ok(!row('a').classList.contains('open'), 'a second click closes it');
    // buttons inside a row do not toggle it
    row('b').querySelector('.archive-btn').click();
    assert.ok(!app.$('taskStack').querySelectorAll('.task-item').some(i => i.classList.contains('open')));
});

test('older stored data still loads and keeps every task after the Done button moved', () => {
    const app = boot({ fileDB: original.fileDB });
    const before = app.stored ? JSON.parse(original.fileDB) : null;
    app.add('new one');
    const stored = app.stored();
    assert.equal(stored.tasks.length, before.tasks.length + 1);
    assert.equal(stored.completed.length, before.completed.length);
    assert.equal(stored.archived.length, before.archived.length);
});
