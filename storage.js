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
    //
    // Two modes share one walker:
    //   strict  (import)  – any invalid item rejects the whole file.
    //   lenient (load)    – data already in this browser was written by this app or an
    //                       earlier version (which never validated anything), so repair what
    //                       can be repaired and drop only items with no usable text.
    // Neither mode limits text or category length: the first version had no limits, and
    // rendering only ever uses textContent. Length limits apply to new input (state.js).

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

    // Collects problems. In strict mode the first problem aborts; in lenient mode it is counted.
    function createReport(lenient) {
        return { lenient, skipped: 0, repaired: 0, error: null };
    }

    // Returns true when the walk may continue.
    function problem(report, kind, error) {
        if (!report.lenient) {
            report.error = error;
            return false;
        }
        report[kind] += 1;
        return true;
    }

    function isName(value) {
        return typeof value === 'string' && value.trim() !== '';
    }

    function normalizeCategories(raw, report) {
        if (raw === undefined || raw === null) return State.DEFAULT_CATEGORIES.slice();
        if (!Array.isArray(raw)) {
            if (!problem(report, 'skipped', '"categories" must be an array of strings.')) return null;
            return State.DEFAULT_CATEGORIES.slice();
        }
        const list = [];
        for (let i = 0; i < raw.length; i++) {
            let name = raw[i];
            if (report.lenient && typeof name === 'number' && Number.isFinite(name)) {
                name = String(name);
                report.repaired += 1;
            }
            if (!isName(name)) {
                if (!problem(report, 'skipped', `categories[${i}] must be a non-empty string.`)) return null;
                continue;
            }
            if (!list.includes(name)) list.push(name);
        }
        return list.length > 0 ? list : State.DEFAULT_CATEGORIES.slice();
    }

    // Returns a clean copy of one task (or null), adding unknown categories to `categories`.
    function normalizeTask(raw, path, timeField, categories, report) {
        if (!isObject(raw)) {
            problem(report, 'skipped', `${path} must be an object.`);
            return null;
        }
        let text = raw.text;
        if (report.lenient && typeof text === 'number' && Number.isFinite(text)) {
            text = String(text);
            report.repaired += 1;
        }
        if (typeof text !== 'string' || !text.trim()) {
            problem(report, 'skipped', `${path}.text must be a non-empty string.`);
            return null;
        }
        let id = raw.id;
        if (!validId(id)) {
            if (!problem(report, 'repaired', `${path}.id must be a number or a string of letters, digits, "-" and "_".`)) return null;
            id = State.newId();
        }
        let category = raw.category;
        if (category === undefined || category === null || category === '') {
            category = categories[0];
        } else if (!isName(category)) {
            if (!problem(report, 'repaired', `${path}.category must be a non-empty string.`)) return null;
            category = categories[0];
        }
        const task = { text, id, category };
        const timeFields = timeField ? ['createdAt', timeField] : ['createdAt'];
        for (const field of timeFields) {
            if (raw[field] === undefined || raw[field] === null) continue;
            if (!validTime(raw[field])) {
                if (!problem(report, 'repaired', `${path}.${field} must be a date string or a number.`)) return null;
                continue;
            }
            task[field] = raw[field];
        }
        if (!categories.includes(category)) categories.push(category);
        return task;
    }

    function normalizeList(raw, name, timeField, categories, report) {
        if (raw === undefined || raw === null) return [];
        // A list of the wrong type is a damaged file, not a bad item: fail in both modes.
        if (!Array.isArray(raw)) {
            report.error = `"${name}" must be an array.`;
            return null;
        }
        const list = [];
        for (let i = 0; i < raw.length; i++) {
            const task = normalizeTask(raw[i], `${name}[${i}]`, timeField, categories, report);
            if (report.error) return null;
            if (task) list.push(task);
        }
        return list;
    }

    /*
     * Validates data and returns a clean, independent copy:
     *   { ok: true, data, skipped, repaired } or { ok: false, error }
     * options.lenient – repair instead of reject (used for data already stored in this browser).
     *                   `skipped` counts dropped items, `repaired` counts changed fields.
     * options.fallbackCurrentCategory – used when the data carries no valid currentCategory.
     */
    function normalizeData(input, options) {
        const opts = options || {};
        if (!isObject(input)) return fail('Data must be a JSON object.');
        const report = createReport(Boolean(opts.lenient));

        const categories = normalizeCategories(input.categories, report);
        if (report.error) return fail(report.error);
        const tasks = normalizeList(input.tasks, 'tasks', null, categories, report);
        if (report.error) return fail(report.error);
        const completed = normalizeList(input.completed, 'completed', 'completedAt', categories, report);
        if (report.error) return fail(report.error);
        const archived = normalizeList(input.archived, 'archived', 'archivedAt', categories, report);
        if (report.error) return fail(report.error);

        // Ids must be unique across all lists; repair collisions instead of rejecting.
        const seen = new Set();
        [tasks, completed, archived].forEach(list => {
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
        } else if (typeof opts.fallbackCurrentCategory === 'string' && categories.includes(opts.fallbackCurrentCategory)) {
            currentCategory = opts.fallbackCurrentCategory;
        }

        return {
            ok: true,
            data: {
                tasks,
                completed,
                archived,
                categories,
                currentCategory
            },
            skipped: report.skipped,
            repaired: report.repaired
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

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function describeRepairs(checked) {
        const parts = [];
        if (checked.skipped > 0) parts.push(`${plural(checked.skipped, 'unreadable item')} skipped`);
        if (checked.repaired > 0) parts.push(`${plural(checked.repaired, 'invalid field')} repaired`);
        return parts.join(', ');
    }

    // Copies the raw fileDB to a backup key. Without a backup, saving is disabled so the
    // original is never overwritten.
    function protectOriginal(result, storage, raw, problemText) {
        result.backupKey = backupRaw(storage, raw);
        if (result.backupKey) {
            result.warnings.push(`${problemText} The original was kept under "${result.backupKey}".`);
        } else {
            result.canSave = false;
            result.warnings.push(`${problemText} No backup could be made, so nothing will be saved.`);
        }
    }

    /*
     * Loads the app data. Returns:
     *   data      – a valid state (defaults if nothing usable was found)
     *   source    – 'fileDB' | 'legacy' | 'empty'
     *   backupKey – set when the raw fileDB was preserved under another key
     *   canSave   – false when a damaged fileDB could not be backed up (do not overwrite it)
     *   warnings  – human-readable notes
     *
     * Stored data is read leniently (see normalizeData): nothing the app ever wrote is
     * rejected for its length, and one bad item never discards the rest.
     *
     * Precedence. Legacy keys (taskStack, ...) are left in place and never deleted:
     *   1. A readable fileDB always wins, even if legacy keys hold different (older) data.
     *      If items had to be skipped or repaired, the raw fileDB is backed up first.
     *   2. A fileDB that cannot be read at all (bad JSON, not an object, a task list that
     *      is not an array) is backed up and reported before legacy keys
     *      (which may be stale) or defaults are used.
     *   3. Without fileDB, legacy keys are migrated into fileDB.
     * Whenever the result differs from what was stored, it is written back right away (only
     * after a backup exists), so each warning is shown once.
     */
    function load(storage) {
        const result = { data: null, source: 'empty', backupKey: null, canSave: true, warnings: [] };
        const legacyCurrent = safeGet(storage, LEGACY_KEYS.currentCategory);

        const raw = safeGet(storage, KEY);
        if (raw !== null) {
            const parsed = parseJson(raw);
            const checked = parsed.ok
                ? normalizeData(parsed.value, { lenient: true, fallbackCurrentCategory: legacyCurrent })
                : parsed;
            if (checked.ok) {
                result.data = checked.data;
                result.source = 'fileDB';
                if (checked.skipped + checked.repaired > 0) {
                    protectOriginal(result, storage, raw, `Some saved data could not be read (${describeRepairs(checked)}).`);
                    if (result.canSave) save(storage, result.data);
                }
                return result;
            }
            protectOriginal(result, storage, raw, `Saved data could not be read (${checked.error}).`);
        }

        const { legacy, found } = readLegacy(storage);
        if (found || legacy.currentCategory) {
            const checked = normalizeData(legacy, { lenient: true });
            if (checked.ok) {
                result.data = checked.data;
                result.source = found ? 'legacy' : 'empty';
                if (found && raw !== null) result.warnings.push('Older saved data was loaded instead.');
                if (checked.skipped + checked.repaired > 0) {
                    result.warnings.push(`Some older saved data could not be read (${describeRepairs(checked)}). The old keys were left unchanged.`);
                }
                if ((found || raw !== null) && result.canSave) save(storage, result.data);
                return result;
            }
            result.warnings.push(`Old saved data could not be used (${checked.error}).`);
        }

        result.data = normalizeData({}).data;
        if (raw !== null && result.canSave) save(storage, result.data);
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
