/*
 * The single source of truth for persistence: localStorage key `fileDB`.
 *
 * Stored shape (kept compatible with every earlier version):
 *   { tasks, completed, archived, categories, currentCategory?, schemaVersion? }
 * `currentCategory` and `schemaVersion` are additive; older data without them loads fine.
 * Import/export use the same shape. No DOM access here.
 */
(function (global) {
    'use strict';

    const State = (typeof module !== 'undefined' && module.exports)
        ? require('./state.js')
        : global.StackTask.State;

    const KEY = 'fileDB';
    const BACKUP_PREFIX = 'fileDB.backup-';
    const SCHEMA_VERSION = 1;
    const MAX_IMPORT_CHARS = 5 * 1024 * 1024;
    const MAX_STORED_TEXT = 5000;
    const MAX_STORED_CATEGORY = 100;
    const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

    // Keys written by versions that duplicated the data. Read for migration only.
    const LEGACY_KEYS = {
        tasks: 'taskStack',
        completed: 'completedTasks',
        archived: 'archivedTasks',
        categories: 'categories',
        currentCategory: 'currentCategory'
    };

    function isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function parseJson(text) {
        try {
            return { ok: true, value: JSON.parse(text) };
        } catch (e) {
            return { ok: false, error: 'File is not valid JSON.' };
        }
    }

    // ---- Validation ----------------------------------------------------

    function validId(id) {
        if (typeof id === 'number') return Number.isFinite(id);
        return typeof id === 'string' && SAFE_ID.test(id);
    }

    function validTime(value) {
        if (typeof value === 'number') return Number.isFinite(value);
        return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    }

    function fail(error) {
        return { ok: false, error };
    }

    function normalizeCategories(raw) {
        if (raw === undefined || raw === null) return { ok: true, list: State.DEFAULT_CATEGORIES.slice() };
        if (!Array.isArray(raw)) return fail('"categories" must be an array of strings.');
        const list = [];
        for (let i = 0; i < raw.length; i++) {
            const name = raw[i];
            if (typeof name !== 'string' || !name.trim()) {
                return fail(`categories[${i}] must be a non-empty string.`);
            }
            if (name.length > MAX_STORED_CATEGORY) return fail(`categories[${i}] is too long.`);
            if (!list.includes(name)) list.push(name);
        }
        return { ok: true, list: list.length > 0 ? list : State.DEFAULT_CATEGORIES.slice() };
    }

    // Returns a clean copy of one task, adding unknown categories to `categories`.
    function normalizeTask(raw, path, timeField, categories, defaultCategory) {
        if (!isObject(raw)) return fail(`${path} must be an object.`);
        if (typeof raw.text !== 'string' || !raw.text.trim()) {
            return fail(`${path}.text must be a non-empty string.`);
        }
        if (raw.text.length > MAX_STORED_TEXT) return fail(`${path}.text is too long.`);
        if (!validId(raw.id)) {
            return fail(`${path}.id must be a number or a string of letters, digits, "-" and "_".`);
        }
        let category = raw.category;
        if (category === undefined || category === null || category === '') {
            category = defaultCategory;
        } else if (typeof category !== 'string' || !category.trim() || category.length > MAX_STORED_CATEGORY) {
            return fail(`${path}.category must be a non-empty string.`);
        }
        const task = { text: raw.text, id: raw.id, category };
        if (raw.createdAt !== undefined) {
            if (!validTime(raw.createdAt)) return fail(`${path}.createdAt must be a date string or a number.`);
            task.createdAt = raw.createdAt;
        }
        if (timeField && raw[timeField] !== undefined) {
            if (!validTime(raw[timeField])) return fail(`${path}.${timeField} must be a date string or a number.`);
            task[timeField] = raw[timeField];
        }
        if (!categories.includes(category)) categories.push(category);
        return { ok: true, task };
    }

    function normalizeList(raw, name, timeField, categories) {
        if (raw === undefined || raw === null) return { ok: true, list: [] };
        if (!Array.isArray(raw)) return fail(`"${name}" must be an array.`);
        const defaultCategory = categories[0];
        const list = [];
        for (let i = 0; i < raw.length; i++) {
            const result = normalizeTask(raw[i], `${name}[${i}]`, timeField, categories, defaultCategory);
            if (!result.ok) return result;
            list.push(result.task);
        }
        return { ok: true, list };
    }

    // Validates untrusted data and returns a clean, independent copy:
    //   { ok: true, data } or { ok: false, error }
    // `fallbackCurrentCategory` is used when the data carries no valid currentCategory.
    function normalizeData(input, fallbackCurrentCategory) {
        if (!isObject(input)) return fail('Data must be a JSON object.');

        const cats = normalizeCategories(input.categories);
        if (!cats.ok) return cats;
        const categories = cats.list;

        const tasks = normalizeList(input.tasks, 'tasks', null, categories);
        if (!tasks.ok) return tasks;
        const completed = normalizeList(input.completed, 'completed', 'completedAt', categories);
        if (!completed.ok) return completed;
        const archived = normalizeList(input.archived, 'archived', 'archivedAt', categories);
        if (!archived.ok) return archived;

        // Ids must be unique across all lists; repair collisions instead of rejecting.
        const seen = new Set();
        [tasks.list, completed.list, archived.list].forEach(list => {
            list.forEach(task => {
                let key = String(task.id);
                while (seen.has(key)) {
                    task.id = State.newId();
                    key = String(task.id);
                }
                seen.add(key);
            });
        });

        let currentCategory = categories[0];
        if (typeof input.currentCategory === 'string' && categories.includes(input.currentCategory)) {
            currentCategory = input.currentCategory;
        } else if (typeof fallbackCurrentCategory === 'string' && categories.includes(fallbackCurrentCategory)) {
            currentCategory = fallbackCurrentCategory;
        }

        return {
            ok: true,
            data: {
                tasks: tasks.list,
                completed: completed.list,
                archived: archived.list,
                categories,
                currentCategory
            }
        };
    }

    // ---- localStorage --------------------------------------------------

    function safeGet(storage, key) {
        try {
            return storage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function toStored(data) {
        return {
            tasks: data.tasks,
            completed: data.completed,
            archived: data.archived,
            categories: data.categories,
            currentCategory: data.currentCategory,
            schemaVersion: SCHEMA_VERSION
        };
    }

    function save(storage, data) {
        try {
            storage.setItem(KEY, JSON.stringify(toStored(data)));
            return { ok: true };
        } catch (error) {
            return { ok: false, error };
        }
    }

    // Keeps the unreadable raw string; never overwrites an earlier backup.
    function backupRaw(storage, raw) {
        let key = BACKUP_PREFIX + Date.now();
        let n = 1;
        while (safeGet(storage, key) !== null) {
            key = BACKUP_PREFIX + Date.now() + '-' + n++;
        }
        try {
            storage.setItem(key, raw);
            return key;
        } catch (e) {
            return null;
        }
    }

    function readLegacy(storage) {
        const legacy = {};
        let found = false;
        ['tasks', 'completed', 'archived', 'categories'].forEach(field => {
            const raw = safeGet(storage, LEGACY_KEYS[field]);
            if (raw === null) return;
            const parsed = parseJson(raw);
            if (parsed.ok && Array.isArray(parsed.value)) {
                legacy[field] = parsed.value;
                found = true;
            }
        });
        const current = safeGet(storage, LEGACY_KEYS.currentCategory);
        if (typeof current === 'string' && current) legacy.currentCategory = current;
        return { legacy, found };
    }

    /*
     * Loads the app data. Returns:
     *   data      – a valid state (defaults if nothing usable was found)
     *   source    – 'fileDB' | 'legacy' | 'empty'
     *   backupKey – set when an unreadable fileDB was preserved under another key
     *   canSave   – false when an unreadable fileDB could not be backed up (do not overwrite it)
     *   warnings  – human-readable notes
     */
    function load(storage) {
        const result = { data: null, source: 'empty', backupKey: null, canSave: true, warnings: [] };
        const legacyCurrent = safeGet(storage, LEGACY_KEYS.currentCategory);

        const raw = safeGet(storage, KEY);
        if (raw !== null) {
            const parsed = parseJson(raw);
            const checked = parsed.ok ? normalizeData(parsed.value, legacyCurrent) : parsed;
            if (checked.ok) {
                result.data = checked.data;
                result.source = 'fileDB';
                return result;
            }
            result.backupKey = backupRaw(storage, raw);
            if (result.backupKey) {
                result.warnings.push(`Saved data could not be read (${checked.error}). A copy was kept under "${result.backupKey}".`);
            } else {
                result.canSave = false;
                result.warnings.push(`Saved data could not be read (${checked.error}) and no backup could be made, so nothing will be saved.`);
            }
        }

        const { legacy, found } = readLegacy(storage);
        if (found || legacy.currentCategory) {
            const checked = normalizeData(legacy);
            if (checked.ok) {
                result.data = checked.data;
                result.source = found ? 'legacy' : 'empty';
                if (found && result.canSave) save(storage, result.data);
                return result;
            }
            result.warnings.push(`Old saved data could not be used (${checked.error}).`);
        }

        result.data = normalizeData({}).data;
        return result;
    }

    // ---- Import / export -----------------------------------------------

    function serialize(data) {
        return JSON.stringify(toStored(data), null, 2);
    }

    function exportFilename(date) {
        return `tasks-backup-${(date || new Date()).toISOString().split('T')[0]}.json`;
    }

    // Parses and validates an import file. Never touches stored data.
    function parseImport(text) {
        if (typeof text !== 'string' || !text.trim()) return fail('The file is empty.');
        if (text.length > MAX_IMPORT_CHARS) return fail('The file is too large.');
        const parsed = parseJson(text);
        if (!parsed.ok) return parsed;
        if (!isObject(parsed.value) || !Array.isArray(parsed.value.tasks)) {
            return fail('Not a task backup: expected an object with a "tasks" array.');
        }
        return normalizeData(parsed.value);
    }

    function summarize(data) {
        return `${data.tasks.length} active, ${data.completed.length} completed, ${data.archived.length} archived`
            + ` in ${data.categories.length} categories`;
    }

    // In-memory stand-in for when localStorage is unavailable.
    function createMemoryStorage() {
        const map = new Map();
        return {
            getItem: key => (map.has(key) ? map.get(key) : null),
            setItem: (key, value) => { map.set(key, String(value)); },
            removeItem: key => { map.delete(key); }
        };
    }

    const api = {
        KEY,
        BACKUP_PREFIX,
        LEGACY_KEYS,
        SCHEMA_VERSION,
        normalizeData,
        load,
        save,
        serialize,
        exportFilename,
        parseImport,
        summarize,
        createMemoryStorage
    };

    global.StackTask = global.StackTask || {};
    global.StackTask.Storage = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
