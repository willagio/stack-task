/*
 * Application controller: wires DOM events to state operations, renders, and persists.
 * All listeners are registered once in init() using event delegation.
 *
 * Destructive actions are not confirmed up front. They run immediately and show an Undo toast,
 * which restores a snapshot of the whole state taken just before the action.
 */
(function (global) {
    'use strict';

    const { State, Storage, Ui, Render, Dnd } = global.StackTask;

    const IDS = [
        'taskInput', 'addTaskBtn', 'popButton', 'taskStack', 'taskPanel', 'archivedTasks', 'completedTasks',
        'archivedCount', 'completedCount', 'tabsList', 'addCategoryBtn', 'renameCategoryBtn', 'deleteCategoryBtn',
        'exportBtn', 'importBtn', 'importFile', 'liveRegion', 'toast', 'toastMessage', 'toastAction', 'toastClose',
        'dialog', 'dialogForm', 'dialogTitle', 'dialogMessage', 'dialogField', 'dialogLabel', 'dialogInput',
        'dialogError', 'dialogOk', 'dialogCancel'
    ];

    function quote(text) {
        const flat = String(text).replace(/\s+/g, ' ').trim();
        return `"${flat.length > 40 ? flat.slice(0, 39) + '…' : flat}"`;
    }

    class TaskStackApp {
        constructor(win) {
            this.win = win;
            this.doc = win.document;
            this.startupNotices = [];
            this.storage = this.openStorage();
            this.canSave = true;
            this.saveErrorShown = false;
            this.init();
        }

        openStorage() {
            try {
                const ls = this.win.localStorage;
                if (ls) return ls;
            } catch (e) {
                // Access can throw when storage is blocked
            }
            this.startupNotices.push('Browser storage is unavailable. Tasks will not be kept after closing this page.');
            return Storage.createMemoryStorage();
        }

        init() {
            this.refs = {};
            IDS.forEach(id => { this.refs[id] = this.doc.getElementById(id); });
            this.refs.stackCount = this.doc.querySelector('.stack-count');
            this.refs.stackLabel = this.doc.querySelector('.stack-label');
            this.ui = Ui.create(this.win, this.refs);
            this.renderer = Render.create(this.doc, this.refs);

            this.loadFromStorage();
            this.bindEvents();
            Dnd.attach(this.refs, {
                onReorderTasks: (draggedId, targetId, above) => {
                    if (State.reorderTasks(this.state, draggedId, targetId, above).ok) this.commit();
                },
                onReorderCategories: (dragged, target, before) => {
                    if (State.reorderCategories(this.state, dragged, target, before).ok) this.commit();
                }
            });
            this.render();
            this.focusInputOnDesktop();
            this.startupNotices.forEach(message => this.ui.notify(message, { kind: 'error' }));
        }

        // A keyboard is at hand on desktop, so start in the input; on touch that would only raise the on-screen keyboard
        focusInputOnDesktop() {
            try {
                if (this.win.matchMedia('(hover: hover) and (pointer: fine)').matches) this.refs.taskInput.focus();
            } catch (e) {
                // No matchMedia: leave focus alone
            }
        }

        // ---- Persistence -------------------------------------------------

        loadFromStorage() {
            const loaded = Storage.load(this.storage);
            this.state = State.createState(loaded.data);
            this.canSave = loaded.canSave;
            if (loaded.warnings.length > 0) this.startupNotices.push(loaded.warnings.join('\n'));
        }

        save() {
            if (!this.canSave) return;
            const result = Storage.save(this.storage, this.state);
            if (!result.ok) {
                console.error('Failed to save tasks:', result.error);
                if (!this.saveErrorShown) {
                    this.saveErrorShown = true;
                    this.ui.notify('Could not save your tasks (browser storage is full or blocked). Export a backup to keep them.', { kind: 'error' });
                }
            }
        }

        // Re-renders while keeping keyboard focus on a sensible element.
        render() {
            const token = this.captureFocus();
            this.renderer.renderAll(this.state);
            this.applyOpenRow();
            this.restoreFocus(token);
            this.syncTicker();
        }

        // On touch the row actions are folded away; tapping a row opens it (one at a time)
        toggleRow(item) {
            this.openId = State.sameId(this.openId, item.dataset.id) ? null : item.dataset.id;
            this.applyOpenRow();
        }

        applyOpenRow() {
            this.itemsOf(this.refs.taskStack).forEach(node => {
                node.classList.toggle('open', this.openId != null && State.sameId(node.dataset.id, this.openId));
            });
        }

        commit() {
            this.ui.hideUndo();
            this.render();
            this.save();
        }

        // ---- Timer ticking -------------------------------------------------
        // The running task's clock is updated in place once a second; nothing else is re-rendered.

        syncTicker() {
            const running = State.runningTask(this.state);
            if (running && !this.ticker && typeof this.win.setInterval === 'function') {
                this.ticker = this.win.setInterval(() => this.tick(), 1000);
            } else if (!running && this.ticker) {
                this.win.clearInterval(this.ticker);
                this.ticker = null;
            }
        }

        tick() {
            const running = State.runningTask(this.state);
            if (!running) { this.syncTicker(); return; }
            const label = this.refs.taskStack.querySelector('.task-time.running');
            if (label && State.sameId(label.dataset.timeFor, running.id)) {
                label.textContent = State.formatClock(State.elapsedMs(running));
            }
        }

        toggleTimer(id) {
            const task = this.findTask(this.state.tasks, id);
            if (!task) return;
            const wasRunning = State.isRunning(task);
            if (!State.toggleTimer(this.state, id).ok) return;
            this.commit();
            const spent = State.elapsedMs(this.findTask(this.state.tasks, id));
            this.ui.announce(wasRunning
                ? `Timer paused for ${quote(task.text)} at ${State.formatDuration(spent)}.`
                : `Timer started for ${quote(task.text)}.`);
        }

        // Applies `change` (a State operation) and offers to undo it.
        withUndo(message, change) {
            const snapshot = State.clone(this.state);
            if (!change().ok) return false;
            this.commit();
            this.ui.notify(message, {
                actionLabel: 'Undo',
                onAction: () => {
                    this.state = snapshot;
                    this.commit();
                    this.ui.announce('Undone.');
                }
            });
            return true;
        }

        // Shows an operation's error message, if it has one.
        report(result) {
            if (!result.ok && result.error) this.ui.notify(result.error, { kind: 'error' });
            return result.ok;
        }

        // ---- Focus -------------------------------------------------------

        captureFocus() {
            const { refs } = this;
            const active = this.doc.activeElement;
            if (!active || active === this.doc.body || typeof active.closest !== 'function') return null;
            if (active === refs.popButton) return { type: 'pop', keyboard: this.isKeyboardFocus(active) };
            if (refs.tabsList.contains(active)) return { type: 'tab' };
            for (const list of [refs.taskStack, refs.archivedTasks, refs.completedTasks]) {
                if (!list.contains(active)) continue;
                const item = active.closest('.task-item, .history-item');
                if (!item) return null;
                return {
                    type: 'item',
                    list,
                    id: item.dataset.id,
                    index: this.itemsOf(list).indexOf(item),
                    key: active.dataset.action || active.className,
                    keyboard: this.isKeyboardFocus(active)
                };
            }
            return null;
        }

        isKeyboardFocus(element) {
            try {
                return element.matches(':focus-visible');
            } catch (e) {
                return true;
            }
        }

        itemsOf(list) {
            return Array.from(list.children).filter(node => node.dataset && node.dataset.id !== undefined);
        }

        restoreFocus(token) {
            if (!token) return;
            const { refs } = this;
            if (token.type === 'tab') {
                const tab = refs.tabsList.querySelector('.tab-active .tab-button');
                if (tab) tab.focus();
            } else if (token.type === 'pop') {
                // The button moves into the new top card (or back home), which drops focus
                if (token.keyboard) (refs.popButton.disabled ? refs.taskInput : refs.popButton).focus();
            } else {
                const items = this.itemsOf(token.list);
                let item = items.find(node => State.sameId(node.dataset.id, token.id));
                // The item itself is gone: only a keyboard user needs to be moved on to its neighbour
                if (!item && token.keyboard) item = items[Math.min(token.index, items.length - 1)];
                if (item) {
                    // The same button if it is still enabled; otherwise the nearest enabled one after it
                    const all = Array.from(item.querySelectorAll('button'));
                    const enabled = all.filter(button => !button.disabled);
                    const keyOf = button => button.dataset.action || button.className;
                    let target = enabled.find(button => keyOf(button) === token.key);
                    if (!target) {
                        const at = all.findIndex(button => keyOf(button) === token.key);
                        target = enabled.find(button => all.indexOf(button) > at)
                            || enabled.filter(button => all.indexOf(button) < at).pop()
                            || enabled[0];
                    }
                    if (target) target.focus();
                } else if (token.keyboard) {
                    const section = token.list.closest('.collapsible-section');
                    const toggle = section && section.querySelector('.section-toggle');
                    (toggle || refs.taskInput).focus();
                }
            }
        }

        // ---- Events ------------------------------------------------------

        bindEvents() {
            const { refs } = this;

            refs.taskInput.addEventListener('keydown', event => {
                // isComposing / keyCode 229: Enter that confirms an IME composition is not a submit
                if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
                this.submitInput();
            });
            refs.addTaskBtn.addEventListener('click', () => this.submitInput());
            refs.popButton.addEventListener('click', () => this.popTask());

            refs.addCategoryBtn.addEventListener('click', () => this.promptNewCategory());
            refs.renameCategoryBtn.addEventListener('click', () => this.promptRenameCategory(this.state.currentCategory));
            refs.deleteCategoryBtn.addEventListener('click', () => this.deleteCategory(this.state.currentCategory));

            refs.tabsList.addEventListener('click', event => {
                const tab = event.target.closest('.tab');
                if (tab) this.switchCategory(tab.dataset.category);
            });
            refs.tabsList.addEventListener('dblclick', event => {
                const tab = event.target.closest('.tab');
                if (tab) this.promptRenameCategory(tab.dataset.category);
            });
            refs.tabsList.addEventListener('keydown', event => this.onTabKeydown(event));

            refs.taskStack.addEventListener('click', event => {
                const button = event.target.closest('.task-action-btn');
                if (!button) {
                    const item = event.target.closest('.task-item');
                    if (item && !(event.detail > 1) && !item.classList.contains('editing') && !event.target.closest('button, input')) this.toggleRow(item);
                    return;
                }
                const id = button.dataset.id;
                switch (button.dataset.action) {
                    case 'timer': this.toggleTimer(id); break;
                    case 'up': this.moveTask(id, 'up'); break;
                    case 'down': this.moveTask(id, 'down'); break;
                    case 'archive': this.archiveTask(id); break;
                    case 'remove': this.removeTask(id); break;
                    default: break;
                }
            });
            // Double-click (or F2 with the keyboard) edits a task's text in place
            refs.taskStack.addEventListener('dblclick', event => {
                const item = event.target.closest && event.target.closest('.task-item');
                if (item && !event.target.closest('button, input')) this.startEdit(item, false);
            });
            refs.taskStack.addEventListener('keydown', event => {
                if (event.key !== 'F2') return;
                const item = event.target.closest && event.target.closest('.task-item');
                if (!item || event.target.closest('input')) return;
                event.preventDefault();
                this.startEdit(item, true);
            });
            refs.archivedTasks.addEventListener('click', event => {
                const restore = event.target.closest('.restore-btn');
                const del = event.target.closest('.delete-archived-btn');
                if (restore) this.restoreArchived(restore.dataset.id);
                else if (del) this.deleteArchived(del.dataset.id);
            });
            refs.completedTasks.addEventListener('click', event => {
                const restore = event.target.closest('.restore-completed-btn');
                const del = event.target.closest('.delete-completed-btn');
                if (restore) this.restoreCompleted(restore.dataset.id);
                else if (del) this.deleteCompleted(del.dataset.id);
            });

            this.doc.querySelectorAll('.collapsible-section .section-toggle').forEach(toggle => {
                toggle.addEventListener('click', () => {
                    const section = toggle.closest('.collapsible-section');
                    const collapsed = section.classList.toggle('collapsed');
                    toggle.setAttribute('aria-expanded', String(!collapsed));
                });
            });

            refs.exportBtn.addEventListener('click', () => this.exportData());
            refs.importBtn.addEventListener('click', () => refs.importFile.click());
            refs.importFile.addEventListener('change', event => this.importData(event));

            // Ctrl/Cmd+Z undoes the last destructive action, except while typing in a field
            this.doc.addEventListener('keydown', event => {
                if (!(event.ctrlKey || event.metaKey) || event.shiftKey || String(event.key || '').toLowerCase() !== 'z') return;
                const tag = event.target && event.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable)) return;
                if (this.ui.hasUndo()) {
                    event.preventDefault();
                    this.ui.runToastAction();
                }
            });

            // Another tab changed the data: pick it up instead of overwriting it later
            this.win.addEventListener('storage', event => {
                if (event.storageArea === this.storage && (event.key === Storage.KEY || event.key === null)) {
                    this.ui.hideUndo();
                    this.loadFromStorage();
                    this.render();
                }
            });
        }

        // Arrow keys / Home / End move between categories; Alt+Arrow moves the category itself.
        onTabKeydown(event) {
            const tab = event.target.closest && event.target.closest('.tab');
            if (!tab) return;
            const names = this.state.categories;
            const index = names.indexOf(tab.dataset.category);
            const count = names.length;
            const left = event.key === 'ArrowLeft';
            const right = event.key === 'ArrowRight';

            if (event.altKey && (left || right)) {
                event.preventDefault();
                const neighbour = names[index + (right ? 1 : -1)];
                if (neighbour && State.reorderCategories(this.state, names[index], neighbour, left).ok) {
                    this.commit();
                    this.ui.announce(`Moved category ${quote(tab.dataset.category)} ${right ? 'right' : 'left'}.`);
                }
                return;
            }
            let next = -1;
            if (right) next = (index + 1) % count;
            else if (left) next = (index - 1 + count) % count;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = count - 1;
            if (next === -1) return;
            event.preventDefault();
            this.switchCategory(names[next]);
        }

        // ---- Actions -----------------------------------------------------

        submitInput() {
            const input = this.refs.taskInput;
            if (this.addTask(input.value)) input.value = '';
            input.focus();
        }

        addTask(text) {
            if (!text.trim()) return false;
            const result = State.push(this.state, text);
            if (!this.report(result)) return false;
            this.commit();
            const count = State.inCategory(this.state.tasks, this.state.currentCategory).length;
            this.ui.announce(`Added ${quote(result.task.text)} to ${this.state.currentCategory}. ${count} ${count === 1 ? 'task' : 'tasks'} in the stack.`);
            return true;
        }

        popTask() {
            const index = State.topTaskIndex(this.state);
            if (index === -1) return;
            const task = this.state.tasks[index];
            const spent = State.elapsedMs(task);
            const detail = spent > 0 ? ` in ${State.formatDuration(spent)}` : '';
            this.withUndo(`Completed ${quote(task.text)}${detail}.`, () => State.pop(this.state));
        }

        findTask(list, id) {
            return list.find(task => State.sameId(task.id, id));
        }

        moveTask(id, direction) {
            const task = this.findTask(this.state.tasks, id);
            if (!task || !State.moveTask(this.state, id, direction).ok) return;
            this.commit();
            const total = State.inCategory(this.state.tasks, task.category).length;
            this.ui.announce(`Moved ${quote(task.text)} ${direction}. Position ${State.positionFromTop(this.state, id)} of ${total}.`);
        }

        // Swaps the row's text for an input; Enter or leaving the field saves, Escape cancels.
        startEdit(item, viaKeyboard) {
            if (item.querySelector('.task-edit')) return;
            const task = this.findTask(this.state.tasks, item.dataset.id);
            const textNode = item.querySelector('.task-text');
            if (!task || !textNode) return;
            const input = this.doc.createElement('input');
            input.type = 'text';
            input.className = 'task-edit';
            input.value = task.text;
            input.maxLength = Math.max(State.MAX_TASK_LENGTH, task.text.length);
            input.setAttribute('aria-label', `Edit task "${task.text}"`);
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('enterkeyhint', 'done');
            item.classList.add('editing');
            textNode.hidden = true;
            textNode.parentNode.insertBefore(input, textNode);

            let done = false;
            const finish = save => {
                if (done) return;
                done = true;
                const value = input.value;
                input.parentNode.removeChild(input);
                textNode.hidden = false;
                item.classList.remove('editing');
                let row = item;
                if (save && value.trim() && value.trim() !== task.text) {
                    const result = State.renameTask(this.state, task.id, value);
                    if (this.report(result)) {
                        this.commit();
                        this.ui.announce(`Renamed to ${quote(result.task.text)}.`);
                        row = this.itemsOf(this.refs.taskStack).find(node => State.sameId(node.dataset.id, task.id));
                    }
                }
                if (viaKeyboard && row) {
                    const button = Array.from(row.querySelectorAll('button')).find(b => !b.disabled);
                    if (button) button.focus();
                }
            };
            input.addEventListener('keydown', event => {
                if (event.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') { event.preventDefault(); finish(true); }
                else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
            });
            input.addEventListener('blur', () => finish(true));
            input.focus();
            input.select();
        }

        removeTask(id) {
            const task = this.findTask(this.state.tasks, id);
            if (task) this.withUndo(`Deleted ${quote(task.text)}.`, () => State.removeTask(this.state, id));
        }

        archiveTask(id) {
            const task = this.findTask(this.state.tasks, id);
            if (task) this.withUndo(`Archived ${quote(task.text)}.`, () => State.archiveTask(this.state, id));
        }

        restoreArchived(id) {
            const task = this.findTask(this.state.archived, id);
            if (task) this.withUndo(`Restored ${quote(task.text)} to the bottom of the stack.`, () => State.restoreArchived(this.state, id));
        }

        deleteArchived(id) {
            const task = this.findTask(this.state.archived, id);
            if (task) this.withUndo(`Deleted ${quote(task.text)}.`, () => State.deleteArchived(this.state, id));
        }

        restoreCompleted(id) {
            const task = this.findTask(this.state.completed, id);
            if (task) this.withUndo(`Restored ${quote(task.text)} to the bottom of the stack.`, () => State.restoreCompleted(this.state, id));
        }

        deleteCompleted(id) {
            const task = this.findTask(this.state.completed, id);
            if (task) this.withUndo(`Deleted ${quote(task.text)}.`, () => State.deleteCompleted(this.state, id));
        }

        categoryError(name, ignoring) {
            const checked = State.validateCategoryName(this.state, name, ignoring);
            return checked.ok ? '' : checked.error;
        }

        async promptNewCategory() {
            const name = await this.ui.askText({
                title: 'New category',
                label: 'Category name',
                confirmLabel: 'Add',
                maxLength: State.MAX_CATEGORY_LENGTH,
                validate: value => this.categoryError(value, null)
            });
            if (name) this.createCategory(name);
        }

        async promptRenameCategory(oldName) {
            const newName = await this.ui.askText({
                title: 'Rename category',
                label: 'Category name',
                value: oldName,
                confirmLabel: 'Rename',
                maxLength: State.MAX_CATEGORY_LENGTH,
                validate: value => this.categoryError(value, oldName)
            });
            if (newName) this.renameCategory(oldName, newName);
        }

        createCategory(name) {
            if (this.report(State.createCategory(this.state, name))) {
                this.commit();
                this.ui.announce(`Category ${quote(this.state.currentCategory)} added.`);
            }
        }

        renameCategory(oldName, newName) {
            if (this.report(State.renameCategory(this.state, oldName, newName))) this.commit();
        }

        deleteCategory(name) {
            if (this.state.categories.length === 1) {
                this.ui.notify('Cannot delete the last category!', { kind: 'error' });
                return;
            }
            const count = State.countInCategory(this.state, name);
            const detail = count > 0 ? ` and its ${count} ${count === 1 ? 'task' : 'tasks'}` : '';
            this.withUndo(`Deleted category ${quote(name)}${detail}.`, () => State.deleteCategory(this.state, name));
        }

        switchCategory(name) {
            if (name !== this.state.currentCategory && State.switchCategory(this.state, name).ok) this.commit();
        }

        // ---- Export / import ----------------------------------------------

        exportData() {
            try {
                const blob = new this.win.Blob([Storage.serialize(this.state)], { type: 'application/json' });
                const url = this.win.URL.createObjectURL(blob);
                const link = this.doc.createElement('a');
                link.href = url;
                link.download = Storage.exportFilename();
                link.style.display = 'none';
                this.doc.body.appendChild(link);
                link.click();
                this.doc.body.removeChild(link);
                this.win.setTimeout(() => this.win.URL.revokeObjectURL(url), 1000);
                this.ui.announce('Backup downloaded.');
            } catch (e) {
                console.error('Failed to export data:', e);
                this.ui.notify('Failed to export data.', { kind: 'error' });
            }
        }

        async importData(event) {
            const input = event.target;
            const file = input.files[0];
            if (!file) return;
            try {
                const result = Storage.parseImport(await file.text());
                if (!result.ok) {
                    this.ui.notify(`Import failed: ${result.error} Your current tasks were not changed.`, { kind: 'error' });
                    return;
                }
                const confirmed = await this.ui.askConfirm({
                    title: 'Import tasks',
                    message: `Replace your current tasks with this file (${Storage.summarize(result.data)})? You can undo this right afterwards.`,
                    confirmLabel: 'Replace',
                    danger: true
                });
                if (!confirmed) return;
                const imported = result.data;
                this.withUndo('Import complete.', () => {
                    this.state = State.createState(imported);
                    this.canSave = true;
                    return { ok: true };
                });
            } catch (e) {
                console.error('Failed to import data:', e);
                this.ui.notify('Import failed: the file could not be read. Your current tasks were not changed.', { kind: 'error' });
            } finally {
                input.value = '';
            }
        }
    }

    function start() {
        new TaskStackApp(global);
    }

    if (global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})(window);
