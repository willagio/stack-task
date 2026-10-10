/*
 * Application controller: wires DOM events to state operations, renders, and persists.
 * All listeners are registered once in init() using event delegation.
 */
(function (global) {
    'use strict';

    const { State, Storage, Render, Dnd } = global.StackTask;

    class TaskStackApp {
        constructor(win) {
            this.win = win;
            this.doc = win.document;
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
            this.win.setTimeout(() => this.win.alert('Browser storage is unavailable. Tasks will not be kept after closing this page.'), 0);
            return Storage.createMemoryStorage();
        }

        init() {
            const byId = id => this.doc.getElementById(id);
            this.refs = {
                taskInput: byId('taskInput'),
                popButton: byId('popButton'),
                taskStack: byId('taskStack'),
                archivedTasks: byId('archivedTasks'),
                completedTasks: byId('completedTasks'),
                tabsList: byId('tabsList'),
                addCategoryBtn: byId('addCategoryBtn'),
                exportBtn: byId('exportBtn'),
                importBtn: byId('importBtn'),
                importFile: byId('importFile'),
                stackCount: this.doc.querySelector('.stack-count')
            };
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
        }

        // ---- Persistence -------------------------------------------------

        loadFromStorage() {
            const loaded = Storage.load(this.storage);
            this.state = State.createState(loaded.data);
            this.canSave = loaded.canSave;
            if (loaded.warnings.length > 0) {
                const message = loaded.warnings.join('\n');
                this.win.setTimeout(() => this.win.alert(message), 0);
            }
        }

        save() {
            if (!this.canSave) return;
            const result = Storage.save(this.storage, this.state);
            if (!result.ok) {
                console.error('Failed to save tasks:', result.error);
                if (!this.saveErrorShown) {
                    this.saveErrorShown = true;
                    this.win.alert('Could not save your tasks (browser storage is full or blocked). Export a backup to keep them.');
                }
            }
        }

        render() {
            this.renderer.renderAll(this.state);
        }

        commit() {
            this.render();
            this.save();
        }

        // Shows an operation's error message, if it has one.
        report(result) {
            if (!result.ok && result.error) this.win.alert(result.error);
            return result.ok;
        }

        // ---- Events ------------------------------------------------------

        bindEvents() {
            const { refs } = this;

            refs.taskInput.addEventListener('keydown', event => {
                // isComposing / keyCode 229: Enter that confirms an IME composition is not a submit
                if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
                if (this.addTask(refs.taskInput.value)) refs.taskInput.value = '';
            });
            refs.popButton.addEventListener('click', () => this.popTask());

            refs.addCategoryBtn.addEventListener('click', () => {
                const name = this.win.prompt('Enter category name:');
                if (name) this.createCategory(name);
            });

            refs.tabsList.addEventListener('click', event => {
                const close = event.target.closest('.tab-close');
                if (close) {
                    this.deleteCategory(close.dataset.category);
                    return;
                }
                const tab = event.target.closest('.tab');
                if (tab) this.switchCategory(tab.dataset.category);
            });
            refs.tabsList.addEventListener('dblclick', event => {
                const tab = event.target.closest('.tab');
                if (!tab || event.target.closest('.tab-close')) return;
                const oldName = tab.dataset.category;
                const newName = this.win.prompt('Rename category:', oldName);
                if (newName) this.renameCategory(oldName, newName);
            });

            refs.taskStack.addEventListener('click', event => {
                const button = event.target.closest('.task-action-btn');
                if (!button) return;
                if (button.dataset.action === 'archive') this.archiveTask(button.dataset.id);
                else if (button.dataset.action === 'remove') this.removeTask(button.dataset.id);
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

            this.doc.querySelectorAll('.collapsible-section .section-header').forEach(header => {
                header.addEventListener('click', () => {
                    header.closest('.collapsible-section').classList.toggle('collapsed');
                });
            });

            refs.exportBtn.addEventListener('click', () => this.exportData());
            refs.importBtn.addEventListener('click', () => refs.importFile.click());
            refs.importFile.addEventListener('change', event => this.importData(event));

            // Another tab changed the data: pick it up instead of overwriting it later
            this.win.addEventListener('storage', event => {
                if (event.storageArea === this.storage && (event.key === Storage.KEY || event.key === null)) {
                    this.loadFromStorage();
                    this.render();
                }
            });
        }

        // ---- Actions -----------------------------------------------------

        addTask(text) {
            if (!text.trim()) return false;
            if (!this.report(State.push(this.state, text))) return false;
            this.commit();
            return true;
        }

        popTask() {
            if (State.pop(this.state).ok) this.commit();
        }

        findTask(list, id) {
            return list.find(task => State.sameId(task.id, id));
        }

        removeTask(id) {
            const task = this.findTask(this.state.tasks, id);
            if (task && this.win.confirm(`Permanently delete "${task.text}"?`)) {
                State.removeTask(this.state, id);
                this.commit();
            }
        }

        archiveTask(id) {
            if (State.archiveTask(this.state, id).ok) this.commit();
        }

        restoreArchived(id) {
            if (State.restoreArchived(this.state, id).ok) this.commit();
        }

        deleteArchived(id) {
            const task = this.findTask(this.state.archived, id);
            if (task && this.win.confirm(`Permanently delete archived task "${task.text}"?`)) {
                State.deleteArchived(this.state, id);
                this.commit();
            }
        }

        restoreCompleted(id) {
            if (State.restoreCompleted(this.state, id).ok) this.commit();
        }

        deleteCompleted(id) {
            const task = this.findTask(this.state.completed, id);
            if (task && this.win.confirm(`Permanently delete completed task "${task.text}"?`)) {
                State.deleteCompleted(this.state, id);
                this.commit();
            }
        }

        createCategory(name) {
            if (this.report(State.createCategory(this.state, name))) this.commit();
        }

        renameCategory(oldName, newName) {
            if (this.report(State.renameCategory(this.state, oldName, newName))) this.commit();
        }

        deleteCategory(name) {
            if (this.state.categories.length === 1) {
                this.win.alert('Cannot delete the last category!');
                return;
            }
            const count = State.countInCategory(this.state, name);
            const message = count > 0
                ? `Delete category "${name}" and ${count} task(s) in it?`
                : `Delete category "${name}"?`;
            if (!this.win.confirm(message)) return;
            if (State.deleteCategory(this.state, name).ok) this.commit();
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
            } catch (e) {
                console.error('Failed to export data:', e);
                this.win.alert('Failed to export data.');
            }
        }

        async importData(event) {
            const input = event.target;
            const file = input.files[0];
            if (!file) return;
            try {
                const result = Storage.parseImport(await file.text());
                if (!result.ok) {
                    this.win.alert(`Import failed: ${result.error}\nYour current tasks were not changed.`);
                    return;
                }
                const message = `Replace your current tasks with this file (${Storage.summarize(result.data)})?`;
                if (!this.win.confirm(message)) return;
                this.state = State.createState(result.data);
                this.canSave = true;
                this.commit();
            } catch (e) {
                console.error('Failed to import data:', e);
                this.win.alert('Import failed: the file could not be read.\nYour current tasks were not changed.');
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
