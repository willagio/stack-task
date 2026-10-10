/*
 * Pure task/category operations. No DOM, no storage.
 *
 * A state object looks like the persisted data:
 *   { tasks, completed, archived, categories, currentCategory }
 * `tasks` is the stack: the last element of a category is its top task.
 * Every operation mutates the state in place and returns { ok, ... }.
 */
(function (global) {
    'use strict';

    const DEFAULT_CATEGORIES = ['Work', 'Personal'];
    const MAX_TASK_LENGTH = 280;
    const MAX_CATEGORY_LENGTH = 40;

    let idCounter = 0;

    // New ids are strings. Older data has numeric ids (Date.now()); both are accepted.
    function newId() {
        try {
            if (global.crypto && typeof global.crypto.randomUUID === 'function') {
                return global.crypto.randomUUID();
            }
        } catch (e) {
            // randomUUID can be unavailable outside secure contexts; use the fallback below
        }
        idCounter += 1;
        return 't' + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function sameId(a, b) {
        return String(a) === String(b);
    }

    function indexOfId(list, id) {
        return list.findIndex(task => sameId(task.id, id));
    }

    function createState(data) {
        const source = data || {};
        const categories = Array.isArray(source.categories) && source.categories.length > 0
            ? source.categories.slice()
            : DEFAULT_CATEGORIES.slice();
        return {
            tasks: Array.isArray(source.tasks) ? source.tasks : [],
            completed: Array.isArray(source.completed) ? source.completed : [],
            archived: Array.isArray(source.archived) ? source.archived : [],
            categories,
            currentCategory: categories.includes(source.currentCategory)
                ? source.currentCategory
                : categories[0]
        };
    }

    // Deep copy of the persisted shape; used as an undo snapshot.
    function clone(state) {
        return createState(JSON.parse(JSON.stringify(state)));
    }

    // ---- Queries -------------------------------------------------------

    function inCategory(list, category) {
        return list.filter(task => task.category === category);
    }

    // Index (in state.tasks) of the top task of the current category, or -1.
    function topTaskIndex(state) {
        for (let i = state.tasks.length - 1; i >= 0; i--) {
            if (state.tasks[i].category === state.currentCategory) return i;
        }
        return -1;
    }

    function countInCategory(state, name) {
        return inCategory(state.tasks, name).length
            + inCategory(state.completed, name).length
            + inCategory(state.archived, name).length;
    }

    // ---- Task operations -----------------------------------------------

    function push(state, text) {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) return { ok: false, error: 'Task is empty.' };
        if (trimmed.length > MAX_TASK_LENGTH) {
            return { ok: false, error: `Task is too long (max ${MAX_TASK_LENGTH} characters).` };
        }
        const task = {
            text: trimmed,
            id: newId(),
            createdAt: new Date().toISOString(),
            category: state.currentCategory
        };
        state.tasks.push(task);
        return { ok: true, task };
    }

    function renameTask(state, id, text) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) return { ok: false, error: 'Task is empty.' };
        if (trimmed.length > MAX_TASK_LENGTH) {
            return { ok: false, error: `Task is too long (max ${MAX_TASK_LENGTH} characters).` };
        }
        state.tasks[index] = { ...state.tasks[index], text: trimmed };
        return { ok: true, task: state.tasks[index] };
    }

    // ---- Timers --------------------------------------------------------
    // A task accumulates `timeSpent` (ms). While its timer runs, `timerStartedAt` holds the start
    // time, so the elapsed time is derived from the clock and survives reloads. One timer at a time.

    function isRunning(task) {
        return typeof task.timerStartedAt === 'string' && !Number.isNaN(Date.parse(task.timerStartedAt));
    }

    function elapsedMs(task, now) {
        const base = typeof task.timeSpent === 'number' && task.timeSpent > 0 ? task.timeSpent : 0;
        if (!isRunning(task)) return base;
        const at = now === undefined ? Date.now() : now;
        return base + Math.max(0, at - Date.parse(task.timerStartedAt));
    }

    // The task with its running time folded into timeSpent and the timer cleared.
    function settled(task, now) {
        if (!isRunning(task)) return task;
        const { timerStartedAt, ...rest } = task;
        return { ...rest, timeSpent: elapsedMs(task, now) };
    }

    function runningTask(state) {
        return state.tasks.find(isRunning) || null;
    }

    function pauseTimer(state, id, now) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        state.tasks[index] = settled(state.tasks[index], now);
        return { ok: true, task: state.tasks[index] };
    }

    function startTimer(state, id, now) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        const at = now === undefined ? Date.now() : now;
        state.tasks = state.tasks.map(task => settled(task, at));
        state.tasks[index] = { ...state.tasks[index], timerStartedAt: new Date(at).toISOString() };
        return { ok: true, task: state.tasks[index] };
    }

    function toggleTimer(state, id, now) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        return isRunning(state.tasks[index]) ? pauseTimer(state, id, now) : startTimer(state, id, now);
    }

    // Completes the top task of the current category (not the global top). Its timer stops.
    function pop(state) {
        const index = topTaskIndex(state);
        if (index === -1) return { ok: false };
        const task = settled(state.tasks.splice(index, 1)[0]);
        const done = { ...task, completedAt: new Date().toISOString() };
        state.completed.unshift(done);
        return { ok: true, task: done };
    }

    function archiveTask(state, id) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        const task = settled(state.tasks.splice(index, 1)[0]);
        const archived = { ...task, archivedAt: new Date().toISOString() };
        state.archived.unshift(archived);
        return { ok: true, task: archived };
    }

    function removeTask(state, id) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        return { ok: true, task: state.tasks.splice(index, 1)[0] };
    }

    // Restored tasks go to the bottom of the stack (index 0).
    function restoreArchived(state, id) {
        const index = indexOfId(state.archived, id);
        if (index === -1) return { ok: false };
        const task = state.archived.splice(index, 1)[0];
        delete task.archivedAt;
        state.tasks.unshift(task);
        return { ok: true, task };
    }

    function deleteArchived(state, id) {
        const index = indexOfId(state.archived, id);
        if (index === -1) return { ok: false };
        return { ok: true, task: state.archived.splice(index, 1)[0] };
    }

    function restoreCompleted(state, id) {
        const index = indexOfId(state.completed, id);
        if (index === -1) return { ok: false };
        const task = state.completed.splice(index, 1)[0];
        delete task.completedAt;
        state.tasks.unshift(task);
        return { ok: true, task };
    }

    function deleteCompleted(state, id) {
        const index = indexOfId(state.completed, id);
        if (index === -1) return { ok: false };
        return { ok: true, task: state.completed.splice(index, 1)[0] };
    }

    // The stack is displayed top-first (reversed), so `insertBefore` means
    // "visually above the target" = a higher index in the array.
    function reorderTasks(state, draggedId, targetId, insertBefore) {
        const draggedIndex = indexOfId(state.tasks, draggedId);
        const targetIndex = indexOfId(state.tasks, targetId);
        if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
            return { ok: false };
        }
        const dragged = state.tasks.splice(draggedIndex, 1)[0];
        let insertIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
        if (insertBefore) insertIndex++;
        state.tasks.splice(insertIndex, 0, dragged);
        return { ok: true };
    }

    // Swaps a task with its neighbour in the same category. 'up' moves it toward the top of the stack.
    function moveTask(state, id, direction) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return { ok: false };
        const category = state.tasks[index].category;
        const step = direction === 'up' ? 1 : -1;
        for (let i = index + step; i >= 0 && i < state.tasks.length; i += step) {
            if (state.tasks[i].category === category) {
                [state.tasks[index], state.tasks[i]] = [state.tasks[i], state.tasks[index]];
                return { ok: true };
            }
        }
        return { ok: false };
    }

    // 1-based position of a task counted from the top of its category's stack, or 0.
    function positionFromTop(state, id) {
        const index = indexOfId(state.tasks, id);
        if (index === -1) return 0;
        const visible = inCategory(state.tasks, state.tasks[index].category);
        return visible.length - visible.findIndex(task => sameId(task.id, id));
    }

    // ---- Category operations -------------------------------------------

    function validateCategoryName(state, name, ignoring) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) return { ok: false, error: 'Category name is empty.' };
        if (trimmed.length > MAX_CATEGORY_LENGTH) {
            return { ok: false, error: `Category name is too long (max ${MAX_CATEGORY_LENGTH} characters).` };
        }
        const lower = trimmed.toLowerCase();
        const clash = state.categories.some(c => c !== ignoring && c.toLowerCase() === lower);
        if (clash) return { ok: false, error: 'Category already exists!' };
        return { ok: true, name: trimmed };
    }

    function createCategory(state, name) {
        const checked = validateCategoryName(state, name, null);
        if (!checked.ok) return checked;
        state.categories.push(checked.name);
        state.currentCategory = checked.name;
        return { ok: true, name: checked.name };
    }

    function renameCategory(state, oldName, newName) {
        const index = state.categories.indexOf(oldName);
        if (index === -1) return { ok: false };
        const checked = validateCategoryName(state, newName, oldName);
        if (!checked.ok) return checked;
        state.categories[index] = checked.name;
        [state.tasks, state.completed, state.archived].forEach(list => {
            list.forEach(task => {
                if (task.category === oldName) task.category = checked.name;
            });
        });
        if (state.currentCategory === oldName) state.currentCategory = checked.name;
        return { ok: true, name: checked.name };
    }

    // Removes the category together with every task in it.
    function deleteCategory(state, name) {
        const index = state.categories.indexOf(name);
        if (index === -1) return { ok: false };
        if (state.categories.length === 1) {
            return { ok: false, error: 'Cannot delete the last category!' };
        }
        state.categories.splice(index, 1);
        state.tasks = state.tasks.filter(task => task.category !== name);
        state.completed = state.completed.filter(task => task.category !== name);
        state.archived = state.archived.filter(task => task.category !== name);
        if (state.currentCategory === name) state.currentCategory = state.categories[0];
        return { ok: true };
    }

    function switchCategory(state, name) {
        if (!state.categories.includes(name)) return { ok: false };
        state.currentCategory = name;
        return { ok: true };
    }

    function reorderCategories(state, draggedName, targetName, insertBefore) {
        const draggedIndex = state.categories.indexOf(draggedName);
        const targetIndex = state.categories.indexOf(targetName);
        if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
            return { ok: false };
        }
        const dragged = state.categories.splice(draggedIndex, 1)[0];
        let insertIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
        if (!insertBefore) insertIndex++;
        state.categories.splice(insertIndex, 0, dragged);
        return { ok: true };
    }

    // ---- Formatting ----------------------------------------------------

    function formatTime(value, now) {
        if (value === undefined || value === null || value === '') return 'Unknown time';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Unknown time';
        const diff = (now === undefined ? Date.now() : now) - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return date.toLocaleDateString();
    }

    // Live clock: m:ss under an hour, h:mm:ss from then on
    function formatClock(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        const two = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
    }

    // Compact summary for finished work: 45s, 12m, 1h 05m
    function formatDuration(ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        if (total < 60) return `${total}s`;
        const h = Math.floor(total / 3600);
        const m = Math.round((total % 3600) / 60);
        if (h === 0) return `${m}m`;
        return `${h}h ${String(m).padStart(2, '0')}m`;
    }

    const api = {
        DEFAULT_CATEGORIES,
        MAX_TASK_LENGTH,
        MAX_CATEGORY_LENGTH,
        newId,
        sameId,
        createState,
        clone,
        inCategory,
        topTaskIndex,
        countInCategory,
        push,
        renameTask,
        isRunning,
        elapsedMs,
        runningTask,
        startTimer,
        pauseTimer,
        toggleTimer,
        formatClock,
        formatDuration,
        pop,
        archiveTask,
        removeTask,
        restoreArchived,
        deleteArchived,
        restoreCompleted,
        deleteCompleted,
        reorderTasks,
        moveTask,
        positionFromTop,
        validateCategoryName,
        createCategory,
        renameCategory,
        deleteCategory,
        switchCategory,
        reorderCategories,
        formatTime
    };

    global.StackTask = global.StackTask || {};
    global.StackTask.State = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
