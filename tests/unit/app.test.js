'use strict';
// Runs the real classic scripts (state, storage, render, dnd, app) in the same order as
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
    const log = { alerts: [], confirms: [], prompts: [], errors: [], downloads: [] };
    const answers = Object.assign({ confirm: true, prompt: null }, dialogs);
    const localStorage = createLocalStorageStub(initialStorage);
    const win = {
        document, localStorage, console: { error: (...a) => log.errors.push(a), log() {}, warn() {} },
        alert: m => log.alerts.push(m),
        confirm: m => { log.confirms.push(m); return typeof answers.confirm === 'function' ? answers.confirm(m) : answers.confirm; },
        prompt: m => { log.prompts.push(m); return typeof answers.prompt === 'function' ? answers.prompt(m) : answers.prompt; },
        setTimeout: fn => { fn(); return 0; },
        addEventListener() {},
        Blob: class { constructor(parts) { this.parts = parts; } },
        URL: { createObjectURL: blob => { log.downloads.push(blob.parts.join('')); return 'blob:x'; }, revokeObjectURL() {} }
    };
    win.window = win;
    vm.createContext(win);
    for (const file of ['state.js', 'storage.js', 'render.js', 'dnd.js', 'app.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), win, { filename: file });
    }
    const $ = id => document.getElementById(id);
    return { win, document, log, localStorage, $,
        stored: () => JSON.parse(localStorage.getItem('fileDB')),
        add(text) { $('taskInput').value = text; $('taskInput').dispatch('keydown', { key: 'Enter' }); },
        topText: () => { const t = $('taskStack').querySelector('.top-task'); return t && t.querySelector('.task-text').textContent; },
        tab: name => document.querySelectorAll('.tab').find(t => t.dataset.category === name)
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

test('delete asks once per click even after many re-renders (delegation registered once)', () => {
    const app = boot({}, { confirm: false });
    for (let i = 0; i < 5; i++) app.add('t' + i);
    assert.equal(app.$('taskStack').listenerCount('click'), 1);
    assert.equal(app.$('completedTasks').listenerCount('click'), 1);
    app.$('taskStack').querySelector('.remove-btn').click();
    assert.equal(app.log.confirms.length, 1, 'cancelled confirm is not repeated');
    assert.equal(app.stored().tasks.length, 5);

    app.win.confirm = () => true;
    app.$('taskStack').querySelector('.remove-btn').click();
    assert.equal(app.stored().tasks.length, 4);
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

test('categories: create, duplicate (case-insensitive), switch, rename, delete', () => {
    const app = boot({}, { prompt: 'Ideas' });
    app.$('addCategoryBtn').click();
    assert.equal(app.stored().currentCategory, 'Ideas');
    app.win.prompt = () => 'ideas';
    app.$('addCategoryBtn').click();
    assert.match(app.log.alerts.at(-1), /already exists/);
    assert.equal(app.stored().categories.length, 3);

    app.tab('Work').click();
    assert.equal(app.stored().currentCategory, 'Work');
    app.win.prompt = () => 'Job';
    app.tab('Work').dispatch('dblclick');
    assert.deepEqual(app.stored().categories, ['Job', 'Personal', 'Ideas']);

    app.add('x');
    app.tab('Job').querySelector('.tab-close').click();
    assert.match(app.log.confirms.at(-1), /Delete category "Job" and 1 task/);
    assert.deepEqual(app.stored().categories, ['Personal', 'Ideas']);
    assert.equal(app.stored().currentCategory, 'Personal');
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
    assert.equal(app.log.alerts.length, 1);
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
    assert.equal(b.$('importFile').value, '', 'file input reset');
});

test('invalid import is rejected with a message and leaves data untouched', async () => {
    const app = boot();
    app.add('precious');
    const before = app.localStorage.getItem('fileDB');
    for (const bad of ['{nope', '{"tasks": [{"text": "<b>", "id": "\\"><img>"}]}', '[]', '{"completed": []}']) {
        await importFile(app, bad);
        assert.match(app.log.alerts.at(-1), /Import failed/);
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

test('collapsible sections toggle from the header', () => {
    const app = boot();
    const section = app.document.querySelector('.archive-section');
    section.querySelector('.section-header').click();
    assert.equal(section.classList.contains('collapsed'), false);
    section.querySelector('.section-header').click();
    assert.equal(section.classList.contains('collapsed'), true);
});

test('drag and drop reorders the stack (delegated listeners)', () => {
    const app = boot();
    ['a', 'b', 'c'].forEach(t => app.add(t));
    assert.equal(app.$('taskStack').listenerCount('drop'), 1);
    const items = () => app.$('taskStack').querySelectorAll('.task-item');
    const [top, , bottom] = items(); // displayed c, b, a
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' };
    bottom.dispatch('dragstart', { dataTransfer: dt });
    top.dispatch('dragover', { dataTransfer: dt, clientY: 5 });
    assert.ok(top.classList.contains('drag-over-top'));
    top.dispatch('drop', { dataTransfer: dt, clientY: 5 }); // upper half of the top item -> above it
    bottom.dispatch('dragend', {});
    assert.deepEqual(app.stored().tasks.map(t => t.text), ['b', 'c', 'a']);
    assert.equal(app.topText(), 'a');
    assert.equal(app.$('taskStack').querySelectorAll('.drag-over-top').length, 0);
});
