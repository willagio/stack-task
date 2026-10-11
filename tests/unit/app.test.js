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

function boot(initialStorage, dialogs, clock) {
    const document = new FakeDocument();
    buildPage(document);
    const log = { alerts: [], confirms: [], prompts: [], errors: [], downloads: [], timers: [], ticks: [] };
    // A controllable clock: the scripts under test see it as Date
    const time = clock || { now: Date.now() };
    class FakeDate extends Date {
        constructor(...args) { if (args.length === 0) super(time.now); else super(...args); }
        static now() { return time.now; }
    }
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
        setInterval: fn => { log.ticks.push(fn); return log.ticks.length; },
        clearInterval() {},
        Date: FakeDate,
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
    return { win, document, log, localStorage, $, time,
        tick: () => log.ticks.at(-1)(),
        stored: () => JSON.parse(localStorage.getItem('fileDB')),
        add(text) { $('taskInput').value = text; $('taskInput').dispatch('keydown', { key: 'Enter' }); },
        topText: () => ($('heroTask').hidden ? null : $('heroText').textContent),
        rows: () => $('taskStack').querySelectorAll('.task-item'),
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
    assert.equal(app.$('heroTask').hidden, true);
    assert.equal(app.$('heroEmpty').hidden, false);
    assert.match(app.$('heroEmpty').textContent, /Empty plate\.What's the one thing\?/);
    assert.equal(app.$('thenLine').hidden, true);
    assert.equal(app.document.title, 'One Tomato');
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
    assert.equal(app.$('heroTask').listenerCount('click'), 1);
    assert.equal(app.$('completedTasks').listenerCount('click'), 1);
    const before = app.stored().tasks.map(t => t.id);
    app.$('heroTask').querySelector('.remove-btn').click(); // top: t4
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
    assert.match(app.toast().text, /Done "b"\. Next tomato!/);
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
    // the hero is the top task; the rows below wait their turn
    const buttons = () => [app.$('heroTask'), ...app.rows()].map(i => ({ up: i.querySelector('.move-up-btn'), down: i.querySelector('.move-down-btn') }));
    assert.equal(buttons()[0].up, null, 'the top task has no "up"');
    assert.equal(buttons()[0].down.disabled, false);
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
    const itemOf = text => app.rows().find(i => i.querySelector('.task-text').textContent === text);
    const bId = itemOf('b').dataset.id;
    itemOf('b').querySelector('.move-up-btn').focus();
    itemOf('b').querySelector('.move-up-btn').click();
    // b is now the top task, shown in the hero: focus follows it there, on a button that works
    assert.equal(app.topText(), 'b');
    assert.equal(app.$('heroTask').dataset.id, bId);
    assert.ok(app.$('heroTask').contains(app.document.activeElement), 'focus moved into the hero');
    assert.equal(app.document.activeElement.disabled, false);
    // a middle item keeps focus on the very same button
    itemOf('a').querySelector('.move-up-btn').focus();
    itemOf('a').querySelector('.move-up-btn').click();
    assert.equal(app.document.activeElement.className.includes('move-up-btn'), true);
    assert.equal(app.document.activeElement.closest('.task-item').dataset.id, itemOf('a').dataset.id);
    // deleting an item with the keyboard moves focus to a neighbour instead of dropping it
    itemOf('c').querySelector('.remove-btn').focus();
    itemOf('c').querySelector('.remove-btn').click();
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
    const icons = app.$('heroTask').querySelectorAll('button');
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
    app.$('heroTask').querySelector('.archive-btn').click(); // archives top: b
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
    a.$('heroTask').querySelector('.archive-btn').click();
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

test('pointer drag reorders the waiting rows: they slide aside, drop above the first row (delegated listeners)', () => {
    const app = boot();
    ['a', 'b', 'c', 'd'].forEach(t => app.add(t));     // hero d; rows c, b, a
    const stack = app.$('taskStack');
    assert.equal(stack.listenerCount('pointerdown'), 1);
    assert.equal(app.$('heroTask').listenerCount('pointerdown'), 0, 'the hero is not a drag target');
    const [first, second, last] = app.rows();
    // Lay the rows out vertically (the fake DOM has no layout): 56px rows, 8px apart
    stack.children.forEach((node, i) => { node.getBoundingClientRect = () => ({ top: i * 64, left: 0, width: 300, height: 56 }); });
    last.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 50, clientY: 156 });
    last.dispatch('pointermove', { pointerId: 1, clientX: 50, clientY: 20 }); // up past the first row
    assert.ok(last.classList.contains('dragging'));
    assert.match(first.style.transform, /translateY\(64px\)/);    // the first row moved down to make room
    assert.match(second.style.transform, /translateY\(64px\)/);
    last.dispatch('pointerup', { pointerId: 1, clientX: 50, clientY: 20 });
    assert.deepEqual(app.stored().tasks.map(t => t.text), ['b', 'c', 'a', 'd']);
    assert.equal(app.topText(), 'd', 'the top task is untouched by a drag below it');
    assert.deepEqual(app.rows().map(r => r.querySelector('.task-text').textContent), ['a', 'c', 'b']);
    assert.equal(stack.querySelectorAll('.dragging').length, 0);
    assert.equal(stack.classList.contains('sorting'), false);
});

test('a pointer drag that ends where it started changes nothing and slides back', () => {
    const app = boot();
    ['a', 'b', 'c'].forEach(t => app.add(t));          // hero c; rows b, a
    const stack = app.$('taskStack');
    const [first] = app.rows();
    stack.children.forEach((node, i) => { node.getBoundingClientRect = () => ({ top: i * 64, left: 0, width: 300, height: 56 }); });
    first.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 10, clientY: 28 });
    first.dispatch('pointermove', { pointerId: 2, clientX: 10, clientY: 40 });
    assert.ok(first.classList.contains('dragging'));
    first.dispatch('pointerup', { pointerId: 2, clientX: 10, clientY: 40 });
    assert.equal(first.style.transform, '');
    assert.equal(app.topText(), 'c');
    assert.deepEqual(app.stored().tasks.map(t => t.text), ['a', 'b', 'c']);
    // clicking a button inside a row never starts a drag
    const button = first.querySelector('.archive-btn');
    button.dispatch('pointerdown', { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 10, clientY: 28 });
    button.dispatch('pointermove', { pointerId: 3, clientX: 10, clientY: 200 });
    assert.equal(first.classList.contains('dragging'), false);
});

test('the hero carries Start and Done; waiting rows have no timer button and no clock', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');
    const hero = app.$('heroTask');
    assert.ok(hero.contains(app.$('popButton')), 'Done lives in the hero');
    assert.ok(hero.contains(app.$('timerButton')), 'Start sits beside Done');
    assert.equal(app.$('popButton').getAttribute('aria-label'), 'Done: "c"');
    assert.equal(app.rows().filter(i => i.querySelector('.timer-btn') || i.querySelector('.task-time')).length, 0);
    assert.equal(app.rows().length, 2);
    assert.equal(app.$('thenLink').textContent, 'Then: b · +1');
    assert.equal(app.$('thenLink').getAttribute('href'), null, 'set in the markup, not by script');
});

test('the Then line names the next task, says so when it is the last, and hides on an empty plate', () => {
    const app = boot();
    assert.equal(app.$('thenLine').hidden, true);
    app.add('only');
    assert.equal(app.$('thenLine').hidden, false);
    assert.equal(app.$('thenLink').hidden, true);
    assert.equal(app.$('thenNone').hidden, false);
    app.add('next');
    assert.equal(app.$('thenLink').hidden, false);
    assert.equal(app.$('thenNone').hidden, true);
    assert.equal(app.$('thenLink').textContent, 'Then: only');
    assert.equal(app.$('stackRest').hidden, false);
});

test('the empty plate: Done is disabled, focus moves on to the input, and Undo brings the task back', () => {
    const app = boot();
    app.add('only');
    app.$('popButton').focus();
    app.$('popButton').click();
    assert.equal(app.$('heroTask').hidden, true);
    assert.equal(app.$('popButton').disabled, true);
    assert.equal(app.document.activeElement, app.$('taskInput'), 'keyboard focus moves on to the input');
    assert.equal(app.$('emptyTitle').textContent, "Plate's clean.");
    assert.match(app.$('emptySub').textContent, /^1 done today/);
    assert.match(app.toast().text, /Done "only"\. Plate's clean!/);
    app.$('toastAction').click();                         // Undo
    assert.equal(app.topText(), 'only');
    assert.equal(app.$('heroTask').hidden, false);
    assert.equal(app.$('popButton').disabled, false);
});

test('keyboard focus stays on Done after it completes a task', () => {
    const app = boot();
    app.add('a'); app.add('b');
    app.$('popButton').focus();
    app.$('popButton').click();
    assert.equal(app.topText(), 'a');
    assert.equal(app.document.activeElement, app.$('popButton'));
});

test('clicking a card opens it (one at a time) and it stays open across re-renders', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');
    const row = text => app.rows().find(i => i.querySelector('.task-text').textContent === text);
    row('b').querySelector('.task-text').click();
    assert.ok(row('b').classList.contains('open'));
    row('a').querySelector('.task-text').click();
    assert.ok(row('a').classList.contains('open'));
    assert.ok(!row('b').classList.contains('open'), 'only one row open');
    row('a').querySelector('.move-up-btn').click();          // re-renders
    assert.ok(row('a').classList.contains('open'), 'still open after a re-render');
    row('a').querySelector('.task-text').click();
    assert.ok(!row('a').classList.contains('open'), 'a second click closes it');
    // the hero opens the same way, and closes whatever else was open
    row('b').querySelector('.task-text').click();
    app.$('heroText').click();
    assert.ok(app.$('heroTask').classList.contains('open'));
    assert.ok(!row('b').classList.contains('open'));
    // buttons inside a row do not toggle it
    app.$('heroText').click();
    row('b').querySelector('.archive-btn').click();
    assert.ok(![app.$('heroTask'), ...app.rows()].some(i => i.classList.contains('open')));
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

test('the hero and its buttons stay in the page while the same task is on top', () => {
    const app = boot();
    app.add('a'); app.add('b'); app.add('c');
    const hero = app.$('heroTask');
    const timer = app.$('timerButton');
    const done = app.$('popButton');
    const row = text => app.rows().find(i => i.querySelector('.task-text').textContent === text);
    // renaming a lower row and then the top task saves on blur and re-renders around the same nodes
    row('b').querySelector('.task-text').dispatch('dblclick');
    const lowerEdit = app.$('taskStack').querySelector('.task-edit');
    lowerEdit.value = 'b2';
    lowerEdit.dispatch('blur');
    assert.ok(row('b2'));
    app.$('heroText').dispatch('dblclick');
    assert.ok(hero.classList.contains('editing'));
    const topEdit = hero.querySelector('.task-edit');
    topEdit.value = 'c2';
    topEdit.dispatch('blur');
    assert.equal(app.topText(), 'c2');
    assert.equal(app.$('hero').querySelector('.top-task'), hero, 'the same card');
    assert.equal(done.getAttribute('aria-label'), 'Done: "c2"');
    assert.equal(hero.querySelectorAll('.task-edit').length, 0);
    assert.equal(hero.classList.contains('editing'), false);
    assert.equal(app.$('heroText').hidden, false);
    // Start is updated in place, label and all
    timer.click();
    assert.ok(timer.classList.contains('running'));
    assert.equal(app.$('timerLabel').textContent, 'Pause');
    assert.equal(timer.getAttribute('aria-label'), 'Pause timer for "c2"');
    assert.equal(app.$('hero').querySelector('.top-task'), hero);
    // Done still completes the renamed top task; the buttons stay where they are
    done.click();
    assert.equal(app.stored().completed[0].text, 'c2');
    assert.equal(app.topText(), 'b2');
    assert.equal(app.$('popButton'), done);
    assert.ok(hero.contains(done));
});

// ---- One Tomato: the 25-minute rules ----------------------------------------------------------

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const db = (tasks, extra) => JSON.stringify({ tasks, completed: [], archived: [], categories: ['Work', 'Personal'], currentCategory: 'Work', ...extra });
const task = (text, id, fields) => ({ text, id, category: 'Work', createdAt: '2026-10-10T08:00:00.000Z', ...fields });
const iso = ms => new Date(ms).toISOString();

test('the clock counts down the current tomato, from time already logged', () => {
    const fresh = boot({ fileDB: db([task('fresh', 'f')]) }, null, { now: T0 });
    assert.equal(fresh.$('heroClock').textContent, '25:00');
    assert.equal(fresh.$('heroStatus').textContent, 'Fresh tomato. Start?');
    assert.equal(fresh.$('timerLabel').textContent, 'Start');
    assert.equal(fresh.$('heroTally').hidden, true);
    // 37 minutes logged by the old count-up timer: one tomato ripe, 12 minutes into the next
    const old = boot({ fileDB: db([task('old', 'o', { timeSpent: 37 * MIN })]) }, null, { now: T0 });
    assert.equal(old.$('heroClock').textContent, '13:00');
    assert.equal(old.$('heroStatus').textContent, 'Half-ripe. Keep going?');
    assert.equal(old.$('heroTally').hidden, false);
    assert.equal(old.$('heroTally').getAttribute('aria-label'), '1 tomato ripened');
    assert.equal(old.$('heroClock').getAttribute('aria-label'), '13 minutes left');
    assert.match(old.$('dialArc').getAttribute('stroke-dasharray'), /^71\.8\d* 138\.23$/); // 13/25 of the wedge
    // the time left follows a running timer
    const running = boot({ fileDB: db([task('go', 'g', { timerStartedAt: iso(T0 - 10 * MIN) })]) }, null, { now: T0 });
    assert.equal(running.$('heroClock').textContent, '15:00');
    assert.equal(running.$('heroStatus').textContent, 'Ripening…');
    assert.equal(running.$('timerLabel').textContent, 'Pause');
    assert.equal(running.document.title, '15:00 · go');
    running.time.now += 11 * MIN + 1000;
    running.tick();
    assert.equal(running.$('heroClock').textContent, '03:59');
    assert.equal(running.$('heroStatus').textContent, 'Almost ripe.');
    assert.equal(running.$('dial').classList.contains('tilt'), true);
    assert.equal(running.document.title, '03:59 · go');
});

test('a tomato that ripens while the page is open stops the timer at exactly 25:00 and says so once', () => {
    const app = boot({ fileDB: db([task('ripen', 'r', { timerStartedAt: iso(T0 - 24 * MIN - 59 * 1000) })]) }, null, { now: T0 });
    assert.equal(app.log.ticks.length, 1, 'the ticker runs while a timer does');
    app.time.now += 1500;                                  // one tick after the boundary
    app.tick();
    const stored = app.stored().tasks[0];
    assert.equal(stored.timeSpent, 25 * MIN);
    assert.equal('timerStartedAt' in stored, false);
    assert.equal(app.stored().completed.length, 0, 'ripe never completes a task');
    assert.equal(app.$('heroStatus').textContent, 'Ripe! Take five, then Done — or one more?');
    assert.equal(app.$('timerLabel').textContent, 'One more');
    // no time left: unlike the full 25:00 of a fresh tomato
    assert.equal(app.$('heroClock').textContent, '00:00');
    assert.equal(app.$('heroClock').getAttribute('aria-label'), 'Ripe: no time left');
    assert.equal(app.$('dialArc').getAttribute('stroke-dasharray'), '0.00 138.23');
    assert.equal(app.$('heroTally').hidden, false);
    assert.equal(app.live(), 'Ripe! "ripen" — 25 minutes done.');
    assert.equal(app.toast().hidden, true, 'on time and in view: the hero says it, no toast');
    assert.equal(app.document.title, 'Ripe! · ripen', 'a signal for a user in another tab');
    // still ripe after a reload, with no new note
    const again = boot({ fileDB: app.localStorage.getItem('fileDB') }, null, app.time);
    assert.equal(again.$('heroStatus').textContent, 'Ripe! Take five, then Done — or one more?');
    assert.equal(again.toast().hidden, true);
    // One more starts a fresh 25 minutes on top of the logged ones
    again.$('timerButton').click();
    assert.equal(again.$('heroClock').textContent, '25:00');
    assert.equal(again.$('heroStatus').textContent, 'Ripening…');
    assert.equal(again.document.title, '25:00 · ripen');
    again.time.now += 5 * MIN;
    again.$('timerButton').click();                        // pause
    assert.equal(again.stored().tasks[0].timeSpent, 30 * MIN);
    assert.equal(again.$('heroClock').textContent, '20:00');
    assert.equal(again.$('heroTally').hidden, false);
});

test('a timer left running while the page was closed is stopped on load, keeping every logged minute', () => {
    const app = boot({ fileDB: db([task('left on', 'l', { timeSpent: 5 * MIN, timerStartedAt: iso(T0 - 3 * 60 * MIN) })]) }, null, { now: T0 });
    const stored = app.stored().tasks[0];
    assert.equal(stored.timeSpent, 185 * MIN, 'nothing that was logged is dropped');
    assert.equal('timerStartedAt' in stored, false);
    assert.match(app.toast().text, /"left on" ran past its tomato while you were away\. Timer stopped; all 3h 05m kept\./);
    assert.equal(app.log.ticks.length, 0, 'no ticker for a stopped timer');
    // it is shown as ripe for this session (nothing extra is stored), so the user can tell it finished
    assert.equal(app.$('heroStatus').textContent, 'Ripe! Take five, then Done — or one more?');
    assert.equal(app.$('timerLabel').textContent, 'One more');
    assert.equal(app.$('heroClock').textContent, '00:00');
    assert.equal(app.document.title, 'Ripe! · left on');
    assert.deepEqual(Object.keys(stored).sort(), ['category', 'createdAt', 'id', 'text', 'timeSpent']);
    // One more starts the clock again from the time kept; paused, it is no longer ripe
    app.$('timerButton').click();
    assert.equal(app.$('heroClock').textContent, '15:00');
    app.time.now += MIN;
    app.$('timerButton').click();
    assert.equal(app.stored().tasks[0].timeSpent, 186 * MIN);
    assert.equal(app.$('heroStatus').textContent, 'Half-ripe. Keep going?');
    assert.equal(app.$('timerLabel').textContent, 'Start');
    assert.equal(app.document.title, 'One Tomato');
    // after a reload the kept time stays, and the session-only ripe look is gone
    const again = boot({ fileDB: app.localStorage.getItem('fileDB') }, null, app.time);
    assert.equal(again.stored().tasks[0].timeSpent, 186 * MIN);
    assert.equal(again.$('timerLabel').textContent, 'Start');
});

test('a click that arrives before the tick still finds the timer stopped at its boundary', () => {
    const app = boot({ fileDB: db([task('late', 'x', { timerStartedAt: iso(T0 - 20 * MIN) })]) }, null, { now: T0 });
    app.time.now += 40 * MIN;                              // background tab: no tick for 40 minutes
    app.$('timerButton').click();                          // the user presses Pause
    const stored = app.stored().tasks[0];
    // the page was open, so the tomato ripened at 25:00; the 35 minutes after that were the app not stopping it
    assert.equal(stored.timeSpent, 25 * MIN, 'recorded at the boundary, however late it is noticed');
    assert.equal('timerStartedAt' in stored, false, 'the click did not start it again');
    assert.equal(app.$('timerLabel').textContent, 'One more');
    assert.equal(app.toast().hidden, false, 'noticed late: a visible toast, not only the live region');
    assert.match(app.toast().text, /Ripe! "late" — 25 minutes done\. The timer stopped at 25:00\./);
    // Done on a timer that is past its boundary reports the real time
    const done = boot({ fileDB: db([task('late', 'y', { timerStartedAt: iso(T0 - 20 * MIN) })]) }, null, { now: T0 });
    done.time.now += 5 * MIN + 500;                        // crossed 25:00 by 500 ms, no tick yet
    done.$('popButton').click();
    assert.match(done.toast().text, /Done "late" in 25m\./);
    assert.equal(done.stored().completed[0].timeSpent, 25 * MIN);
});

test('a tomato noticed late by a throttled or frozen tick is still recorded at exactly 25:00, with a visible toast', () => {
    for (const late of [40 * 1000, 10 * MIN]) {
        const app = boot({ fileDB: db([task('slow tab', 's')]) }, null, { now: T0 });
        app.$('timerButton').click();
        app.time.now += 25 * MIN + late;                   // the first tick after the boundary comes late
        app.tick();
        const stored = app.stored().tasks[0];
        assert.equal(stored.timeSpent, 25 * MIN, `${late} ms late`);
        assert.equal('timerStartedAt' in stored, false);
        assert.equal(app.$('heroClock').textContent, '00:00');
        assert.equal(app.$('heroStatus').textContent, 'Ripe! Take five, then Done — or one more?');
        assert.equal(app.$('timerLabel').textContent, 'One more');
        assert.equal(app.document.title, 'Ripe! · slow tab');
        assert.equal(app.toast().hidden, false);
        assert.equal(app.toast().canUndo, false);
        assert.match(app.toast().text, /Ripe! "slow tab" — 25 minutes done\. The timer stopped at 25:00\./);
    }
    // a few seconds late is an ordinary tick: the hero shows it, the live region says it, no toast
    const prompt = boot({ fileDB: db([task('prompt', 'p')]) }, null, { now: T0 });
    prompt.$('timerButton').click();
    prompt.time.now += 25 * MIN + 3000;
    prompt.tick();
    assert.equal(prompt.stored().tasks[0].timeSpent, 25 * MIN);
    assert.equal(prompt.toast().hidden, true);
    assert.equal(prompt.live(), 'Ripe! "prompt" — 25 minutes done.');
});

test('coming back to the tab settles a ripe tomato at once; one that ripened while hidden is toasted on return', () => {
    const app = boot({ fileDB: db([task('away', 'w')]) }, null, { now: T0 });
    app.$('timerButton').click();
    app.time.now += 25 * MIN + 10 * MIN;                   // frozen: no tick at all
    app.document.dispatch('visibilitychange');
    assert.equal(app.stored().tasks[0].timeSpent, 25 * MIN);
    assert.equal(app.$('timerLabel').textContent, 'One more');
    assert.equal(app.toast().hidden, false);
    assert.match(app.toast().text, /Ripe! "away" — 25 minutes done\./);
    // ripened by a (throttled) tick while the tab was hidden: the toast waits until the user is back
    const hidden = boot({ fileDB: db([task('hidden', 'h')]) }, null, { now: T0 });
    hidden.$('timerButton').click();
    hidden.document.hidden = true;
    hidden.time.now += 25 * MIN + 1000;
    hidden.tick();
    assert.equal(hidden.stored().tasks[0].timeSpent, 25 * MIN);
    assert.equal(hidden.document.title, 'Ripe! · hidden');
    assert.equal(hidden.toast().hidden, true, 'no toast that would time out unseen');
    assert.equal(hidden.live(), 'Ripe! "hidden" — 25 minutes done.');
    hidden.document.hidden = false;
    hidden.document.dispatch('visibilitychange');
    assert.equal(hidden.toast().hidden, false);
    assert.equal(hidden.toast().text, 'Ripe! "hidden" — 25 minutes done.');
});

test('Done, Archive or Undo right after the boundary record the tomato at 25:00, not the time the tick was late', () => {
    const done = boot({ fileDB: db([task('rest', 'a'), task('do it', 'd')]) }, null, { now: T0 });
    done.$('timerButton').click();
    done.time.now += 25 * MIN + 40 * 1000;
    done.$('popButton').click();
    assert.equal(done.stored().completed[0].timeSpent, 25 * MIN);
    assert.match(done.toast().text, /^Done "do it" in 25m\. Next tomato! Ripe! "do it" — 25 minutes done\. The timer stopped at 25:00\.$/);
    assert.equal(done.toast().canUndo, true);
    // Undo brings it back ripe, not running again
    done.$('toastAction').click();
    assert.equal(done.stored().tasks[1].timeSpent, 25 * MIN);
    assert.equal('timerStartedAt' in done.stored().tasks[1], false);
    assert.equal(done.$('timerLabel').textContent, 'One more');
    assert.equal(done.document.title, 'Ripe! · do it');
    // Archive (with Undo) after a 10-minute late boundary
    const archived = boot({ fileDB: db([task('file it', 'f')]) }, null, { now: T0 });
    archived.$('timerButton').click();
    archived.time.now += 35 * MIN;
    archived.$('heroTask').querySelector('.archive-btn').click();
    assert.equal(archived.stored().archived[0].timeSpent, 25 * MIN);
    // Delete of a running task, then Undo after its boundary: the page was still watching it
    const undo = boot({ fileDB: db([task('oops', 'o')]) }, null, { now: T0 });
    undo.$('timerButton').click();
    undo.time.now += 20 * MIN;
    undo.$('heroTask').querySelector('.remove-btn').click();
    undo.time.now += 10 * MIN;
    undo.$('toastAction').click();
    assert.equal(undo.stored().tasks[0].timeSpent, 25 * MIN);
    assert.equal(undo.$('timerLabel').textContent, 'One more');
});

test('a running timer is paused when something else becomes the top task', () => {
    const app = boot({ fileDB: db([task('first', 'a'), task('second', 'b')]) }, null, { now: T0 });
    app.$('timerButton').click();                          // runs "second"
    assert.ok(app.stored().tasks[1].timerStartedAt);
    app.time.now += 4 * MIN;
    app.add('urgent');
    const tasks = app.stored().tasks;
    assert.equal('timerStartedAt' in tasks[1], false, 'the buried timer is paused');
    assert.equal(tasks[1].timeSpent, 4 * MIN, 'with its time kept');
    assert.match(app.live(), /Paused "second" — new thing on top\./);
    assert.equal(app.$('timerLabel').textContent, 'Start');
    assert.equal(app.rows().filter(r => r.querySelector('.timer-btn')).length, 0);
    // a timer on another category's top task keeps running
    app.$('timerButton').click();                          // runs "urgent"
    app.tab('Personal').click();
    assert.ok(app.stored().tasks.find(t => t.text === 'urgent').timerStartedAt);
    assert.match(app.document.title, /^\d\d:\d\d · urgent$/);
    // old data that has a timer on a buried task is fixed up on load
    const old = boot({ fileDB: db([task('under', 'u', { timerStartedAt: iso(T0 - 2 * MIN) }), task('over', 'v')]) }, null, { now: T0 });
    assert.equal('timerStartedAt' in old.stored().tasks[0], false);
    assert.equal(old.stored().tasks[0].timeSpent, 2 * MIN);
});

test('the clean-plate screen counts today\'s finished tasks and their ripe tomatoes', () => {
    const doneToday = (text, id, spent) => task(text, id, { timeSpent: spent, completedAt: iso(T0 - 60 * MIN) });
    const raw = db([], { completed: [doneToday('x', 'c1', 55 * MIN), doneToday('y', 'c2', 10 * MIN), task('old', 'c3', { completedAt: '2024-01-01T10:00:00.000Z' })] });
    const app = boot({ fileDB: raw }, null, { now: T0 });
    assert.equal(app.$('emptyTitle').textContent, "Plate's clean.");
    assert.equal(app.$('emptySub').textContent.startsWith('2 done today'), true);
    assert.equal(app.$('emptySub').querySelectorAll('svg').length, 2, 'x ripened two tomatoes');
});

test('the original v0 data is read in full and every old field survives a save', () => {
    const expected = JSON.parse(original.fileDB);
    const app = boot({ fileDB: original.fileDB }, null, { now: T0 });
    assert.equal(app.topText(), 'Email "Bob" & <team>');
    app.add('new one');
    app.$('timerButton').click();
    app.$('timerButton').click();
    const stored = app.stored();
    expected.tasks.forEach((old, i) => {
        const now = stored.tasks[i];
        Object.keys(old).forEach(key => assert.deepEqual(now[key], old[key], `task ${old.id} keeps ${key}`));
    });
    assert.deepEqual(stored.completed, expected.completed);
    assert.deepEqual(stored.archived, expected.archived);
    assert.deepEqual(stored.categories, expected.categories);
});
