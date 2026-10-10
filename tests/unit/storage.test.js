'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const State = require('../../state.js');
const Storage = require('../../storage.js');
const { createLocalStorageStub, XSS } = require('./helpers.js');

const original = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/original-v0.json'), 'utf8'));

function sample() {
    const s = State.createState();
    State.push(s, 'one'); State.push(s, 'two'); State.pop(s);
    State.switchCategory(s, 'Personal'); State.push(s, 'three');
    const archivedId = s.tasks[0].id;
    State.archiveTask(s, archivedId);
    State.createCategory(s, 'Ideas');
    State.push(s, 'idea');
    return s;
}

// ---- Persistence ----------------------------------------------------

test('save -> load restores identical data, including currentCategory', () => {
    const ls = createLocalStorageStub();
    const s = sample();
    assert.equal(Storage.save(ls, s).ok, true);
    const loaded = Storage.load(ls);
    assert.equal(loaded.source, 'fileDB');
    assert.deepEqual(loaded.data, s);
    assert.equal(loaded.data.currentCategory, 'Ideas');
});

test('save writes only the fileDB key (no duplicate legacy keys)', () => {
    const ls = createLocalStorageStub();
    Storage.save(ls, sample());
    assert.deepEqual(ls.keys(), ['fileDB']);
    const stored = JSON.parse(ls.getItem('fileDB'));
    assert.deepEqual(Object.keys(stored).sort(),
        ['archived', 'categories', 'completed', 'currentCategory', 'schemaVersion', 'tasks']);
});

test('save reports failure instead of throwing', () => {
    const ls = createLocalStorageStub();
    ls.failSet = true;
    assert.equal(Storage.save(ls, sample()).ok, false);
});

test('empty storage loads defaults', () => {
    const loaded = Storage.load(createLocalStorageStub());
    assert.equal(loaded.source, 'empty');
    assert.deepEqual(loaded.data, {
        tasks: [], completed: [], archived: [], categories: ['Work', 'Personal'], currentCategory: 'Work'
    });
});

// ---- Compatibility with data written by earlier versions -----------------

test('ORIGINAL fileDB (written by the first version) loads unchanged', () => {
    const ls = createLocalStorageStub({ fileDB: original.fileDB });
    const loaded = Storage.load(ls);
    assert.equal(loaded.source, 'fileDB');
    assert.deepEqual(loaded.data.tasks, original.expected.tasks);
    assert.deepEqual(loaded.data.completed, original.expected.completed);
    assert.deepEqual(loaded.data.archived, original.expected.archived);
    assert.deepEqual(loaded.data.categories, original.expected.categories);
    assert.equal(loaded.data.currentCategory, 'Work', 'no legacy key: first category');
    assert.deepEqual(ls.keys(), ['fileDB'], 'loading does not write anything');
    assert.equal(ls.getItem('fileDB'), original.fileDB);
});

test('ORIGINAL fileDB + legacy currentCategory key keeps the selected tab', () => {
    const ls = createLocalStorageStub({ fileDB: original.fileDB, currentCategory: 'Personal' });
    assert.equal(Storage.load(ls).data.currentCategory, 'Personal');
    const unknown = createLocalStorageStub({ fileDB: original.fileDB, currentCategory: 'Gone' });
    assert.equal(Storage.load(unknown).data.currentCategory, 'Work');
});

test('all keys written by the old app (fileDB + duplicates) load unchanged', () => {
    const ls = createLocalStorageStub({ fileDB: original.fileDB, ...original.legacy });
    const loaded = Storage.load(ls);
    assert.deepEqual(loaded.data.tasks, original.expected.tasks);
    assert.equal(loaded.data.currentCategory, 'Personal');
});

test('legacy-only keys (no fileDB) are migrated, including currentCategory', () => {
    const ls = createLocalStorageStub({ ...original.legacy });
    const loaded = Storage.load(ls);
    assert.equal(loaded.source, 'legacy');
    assert.deepEqual(loaded.data.tasks, original.expected.tasks);
    assert.deepEqual(loaded.data.completed, original.expected.completed);
    assert.deepEqual(loaded.data.archived, original.expected.archived);
    assert.deepEqual(loaded.data.categories, original.expected.categories);
    assert.equal(loaded.data.currentCategory, 'Personal');
    // migrated into fileDB; legacy keys are left alone
    assert.deepEqual(JSON.parse(ls.getItem('fileDB')).tasks, original.expected.tasks);
    assert.equal(ls.getItem('taskStack'), original.legacy.taskStack);
});

test('old data without categories or task categories gets defaults', () => {
    const raw = JSON.stringify({ tasks: [{ text: 'a', id: 1, createdAt: '2024-01-01T00:00:00Z' }], completed: [], archived: [] });
    const loaded = Storage.load(createLocalStorageStub({ fileDB: raw }));
    assert.deepEqual(loaded.data.categories, ['Work', 'Personal']);
    assert.equal(loaded.data.tasks[0].category, 'Work');
});

test('corrupted fileDB is backed up, not overwritten, and the app starts fresh', () => {
    const ls = createLocalStorageStub({ fileDB: '{"tasks": [broken' });
    const loaded = Storage.load(ls);
    assert.equal(loaded.source, 'empty');
    assert.ok(loaded.backupKey && loaded.backupKey.startsWith(Storage.BACKUP_PREFIX));
    assert.equal(ls.getItem(loaded.backupKey), '{"tasks": [broken');
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.canSave, true);
});

test('structurally invalid fileDB is backed up too, then legacy keys are tried', () => {
    const ls = createLocalStorageStub({ fileDB: '{"tasks": "nope"}', ...original.legacy });
    const loaded = Storage.load(ls);
    assert.equal(loaded.source, 'legacy');
    assert.ok(loaded.backupKey);
    assert.equal(ls.getItem(loaded.backupKey), '{"tasks": "nope"}');
});

test('two corrupted loads keep two distinct backups', () => {
    const ls = createLocalStorageStub({ fileDB: 'x1' });
    const a = Storage.load(ls).backupKey;
    ls.setItem('fileDB', 'x2');
    const b = Storage.load(ls).backupKey;
    assert.notEqual(a, b);
    assert.equal(ls.getItem(a), 'x1');
    assert.equal(ls.getItem(b), 'x2');
});

test('if the backup cannot be written, saving is disabled to protect the original', () => {
    const ls = createLocalStorageStub({ fileDB: 'broken' });
    ls.failSet = true;
    const loaded = Storage.load(ls);
    assert.equal(loaded.canSave, false);
    assert.equal(ls.getItem('fileDB'), 'broken');
});

test('duplicate ids from old data are repaired instead of lost', () => {
    const raw = JSON.stringify({ tasks: [
        { text: 'a', id: 5, category: 'Work' }, { text: 'b', id: 5, category: 'Work' }
    ], completed: [{ text: 'c', id: '5', category: 'Work' }] });
    const data = Storage.load(createLocalStorageStub({ fileDB: raw })).data;
    const ids = [...data.tasks, ...data.completed].map(t => String(t.id));
    assert.equal(new Set(ids).size, 3);
    assert.equal(data.tasks.length + data.completed.length, 3);
});

// ---- Export / import ---------------------------------------------------

test('export -> import round trip', () => {
    const s = sample();
    const text = Storage.serialize(s);
    const result = Storage.parseImport(text);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, s);
});

test('original-format backup files import', () => {
    const text = JSON.stringify(original.expected, null, 2);
    const result = Storage.parseImport(text);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.tasks, original.expected.tasks);
    assert.equal(result.data.currentCategory, 'Work');
});

test('import adds unknown task categories and fixes a missing/invalid currentCategory', () => {
    const result = Storage.parseImport(JSON.stringify({
        tasks: [{ text: 'a', id: 1, category: 'Brand new' }],
        categories: ['Work'], currentCategory: 'Nope'
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.categories, ['Work', 'Brand new']);
    assert.equal(result.data.currentCategory, 'Work');
    assert.deepEqual(result.data.completed, []);
});

test('import applies all fields: tasks, completed, archived, categories', () => {
    const s = sample();
    const result = Storage.parseImport(Storage.serialize(s));
    assert.equal(result.data.archived.length, 1);
    assert.equal(result.data.completed.length, 1);
    assert.deepEqual(result.data.categories, ['Work', 'Personal', 'Ideas']);
});

const INVALID = {
    'not json': '{nope',
    'empty': '   ',
    'array root': '[]',
    'string root': '"hi"',
    'no tasks array': '{"completed": []}',
    'tasks not array': '{"tasks": {}}',
    'task not object': '{"tasks": ["x"]}',
    'text missing': '{"tasks": [{"id": 1, "category": "Work"}]}',
    'text not string': '{"tasks": [{"text": 5, "id": 1}]}',
    'text blank': '{"tasks": [{"text": "  ", "id": 1}]}',
    'id missing': '{"tasks": [{"text": "a"}]}',
    'id unsafe string': JSON.stringify({ tasks: [{ text: 'a', id: '"><img src=x onerror=alert(1)>' }] }),
    'id with space': JSON.stringify({ tasks: [{ text: 'a', id: 'a b' }] }),
    'id object': '{"tasks": [{"text": "a", "id": {}}]}',
    'id null': '{"tasks": [{"text": "a", "id": null}]}',
    'category not string': '{"tasks": [{"text": "a", "id": 1, "category": 3}]}',
    'categories not array': '{"tasks": [], "categories": "Work"}',
    'categories with non-string': '{"tasks": [], "categories": ["Work", 4]}',
    'categories with blank': '{"tasks": [], "categories": ["Work", " "]}',
    'bad createdAt': '{"tasks": [{"text": "a", "id": 1, "createdAt": "yesterday-ish"}]}',
    'bad completedAt type': '{"tasks": [], "completed": [{"text": "a", "id": 1, "completedAt": {}}]}',
    'completed not array': '{"tasks": [], "completed": 1}',
    'archived item bad': '{"tasks": [], "archived": [null]}'
};
for (const [name, text] of Object.entries(INVALID)) {
    test(`invalid import rejected: ${name}`, () => {
        const result = Storage.parseImport(text);
        assert.equal(result.ok, false);
        assert.ok(typeof result.error === 'string' && result.error.length > 0);
    });
}

test('oversized import is rejected', () => {
    assert.equal(Storage.parseImport('{"tasks": [], "pad": "' + 'x'.repeat(5 * 1024 * 1024) + '"}').ok, false);
});

test('malicious text/category are kept as inert data, not lost or altered', () => {
    const evil = `${XSS}" onmouseover="alert(1)' <script>alert(2)</script>`;
    const result = Storage.parseImport(JSON.stringify({
        tasks: [{ text: evil, id: 'a1', category: evil }],
        completed: [{ text: evil, id: 'a2', category: evil, completedAt: '2024-01-01T00:00:00Z' }],
        categories: [evil]
    }));
    assert.equal(result.ok, true);
    assert.equal(result.data.tasks[0].text, evil);
    assert.equal(result.data.tasks[0].category, evil);
    assert.deepEqual(result.data.categories, [evil]);
    // and survives save -> load
    const ls = createLocalStorageStub();
    Storage.save(ls, result.data);
    assert.deepEqual(Storage.load(ls).data, result.data);
});

test('invalid import does not touch stored data (parseImport is side-effect free)', () => {
    const ls = createLocalStorageStub();
    Storage.save(ls, sample());
    const before = ls.getItem('fileDB');
    assert.equal(Storage.parseImport('{"tasks": [{"text": 1}]}').ok, false);
    assert.equal(ls.getItem('fileDB'), before);
});

test('import drops unknown fields and prototype pollution keys', () => {
    const result = Storage.parseImport('{"tasks": [{"text": "a", "id": 1, "category": "Work", "__proto__": {"x": 1}, "extra": "z"}], "__proto__": {"polluted": true}}');
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.data.tasks[0]).sort(), ['category', 'id', 'text']);
    assert.equal({}.polluted, undefined);
});

test('exportFilename uses the date', () => {
    assert.equal(Storage.exportFilename(new Date('2024-03-04T10:00:00Z')), 'tasks-backup-2024-03-04.json');
});
