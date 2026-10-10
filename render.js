/*
 * DOM rendering. Elements are built with createElement/textContent/dataset only;
 * no string derived from user data is ever parsed as HTML.
 */
(function (global) {
    'use strict';

    const State = (typeof module !== 'undefined' && module.exports)
        ? require('./state.js')
        : global.StackTask.State;

    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Static icon definitions: [tag, attributes]
    const ICONS = {
        grip: { size: 16, shapes: [
            ['circle', { cx: 6, cy: 4, r: 1, fill: 'currentColor' }],
            ['circle', { cx: 10, cy: 4, r: 1, fill: 'currentColor' }],
            ['circle', { cx: 6, cy: 8, r: 1, fill: 'currentColor' }],
            ['circle', { cx: 10, cy: 8, r: 1, fill: 'currentColor' }],
            ['circle', { cx: 6, cy: 12, r: 1, fill: 'currentColor' }],
            ['circle', { cx: 10, cy: 12, r: 1, fill: 'currentColor' }]
        ] },
        archive: { size: 14, shapes: [
            ['path', { d: 'M1 3.5H13M2.5 3.5V11.5C2.5 12.0523 2.94772 12.5 3.5 12.5H10.5C11.0523 12.5 11.5 12.0523 11.5 11.5V3.5M4.5 1.5H9.5M5.5 6.5H8.5', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
        ] },
        close: { size: 14, shapes: [
            ['path', { d: 'M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }]
        ] },
        restore: { size: 14, shapes: [
            ['path', { d: 'M7 3.5V10.5M7 3.5L4.5 6M7 3.5L9.5 6', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
        ] }
    };

    function create(doc, refs) {
        // el('div', { class, text, attrs, data }, children)
        function el(tag, options, children) {
            const node = doc.createElement(tag);
            const opts = options || {};
            if (opts.class) node.className = opts.class;
            if (opts.text !== undefined) node.textContent = opts.text;
            Object.keys(opts.attrs || {}).forEach(name => node.setAttribute(name, opts.attrs[name]));
            Object.keys(opts.data || {}).forEach(name => { node.dataset[name] = String(opts.data[name]); });
            (children || []).forEach(child => node.appendChild(child));
            return node;
        }

        function icon(name) {
            const def = ICONS[name];
            const svg = doc.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('width', def.size);
            svg.setAttribute('height', def.size);
            svg.setAttribute('viewBox', `0 0 ${def.size} ${def.size}`);
            svg.setAttribute('fill', 'none');
            svg.setAttribute('aria-hidden', 'true');
            def.shapes.forEach(([tag, attrs]) => {
                const shape = doc.createElementNS(SVG_NS, tag);
                Object.keys(attrs).forEach(key => shape.setAttribute(key, attrs[key]));
                svg.appendChild(shape);
            });
            return svg;
        }

        function iconButton(className, iconName, label, data) {
            return el('button', {
                class: className,
                attrs: { type: 'button', title: label, 'aria-label': label },
                data
            }, [icon(iconName)]);
        }

        function emptyState(...lines) {
            const node = el('div', { class: 'empty-state' });
            lines.forEach((line, i) => {
                if (i > 0) node.appendChild(doc.createElement('br'));
                node.appendChild(doc.createTextNode(line));
            });
            return node;
        }

        function renderTabs(state) {
            const tabs = state.categories.map(category => {
                const active = category === state.currentCategory;
                return el('div', {
                    class: active ? 'tab tab-active' : 'tab',
                    attrs: { draggable: 'true' },
                    data: { category }
                }, [
                    el('span', { class: 'tab-name', text: category }),
                    el('button', {
                        class: 'tab-close',
                        text: '×',
                        attrs: { type: 'button', title: 'Delete category', 'aria-label': `Delete category ${category}` },
                        data: { category }
                    })
                ]);
            });
            refs.tabsList.replaceChildren(...tabs);
        }

        function renderStack(state) {
            const visible = State.inCategory(state.tasks, state.currentCategory);
            if (visible.length === 0) {
                refs.taskStack.replaceChildren(emptyState('No tasks in stack', 'Add one to get started!'));
                return;
            }
            // Top of the stack first
            const items = visible.map((task, index) => {
                const isTop = index === visible.length - 1;
                return el('div', {
                    class: isTop ? 'task-item top-task' : 'task-item',
                    attrs: { draggable: 'true' },
                    data: { id: task.id }
                }, [
                    el('div', { class: 'drag-handle' }, [icon('grip')]),
                    el('div', { class: 'task-index', text: `#${visible.length - index}` }),
                    el('div', { class: 'task-text', text: task.text }),
                    el('div', { class: 'task-actions' }, [
                        iconButton('task-action-btn archive-btn', 'archive', 'Archive task', { action: 'archive', id: task.id }),
                        iconButton('task-action-btn remove-btn', 'close', 'Remove task', { action: 'remove', id: task.id })
                    ])
                ]);
            }).reverse();
            refs.taskStack.replaceChildren(...items);
        }

        function renderHistory(container, tasks, spec) {
            if (tasks.length === 0) {
                container.replaceChildren(emptyState(spec.empty));
                return;
            }
            container.replaceChildren(...tasks.map(task => el('div', {
                class: spec.itemClass,
                data: { id: task.id }
            }, [
                el('div', { class: spec.contentClass }, [
                    el('div', { class: spec.textClass, text: task.text }),
                    el('div', { class: spec.timeClass, text: State.formatTime(task[spec.timeField]) })
                ]),
                el('div', { class: spec.actionsClass }, [
                    iconButton(spec.restoreClass, 'restore', 'Restore to stack', { id: task.id }),
                    iconButton(spec.deleteClass, 'close', 'Permanently delete', { id: task.id })
                ])
            ])));
        }

        function renderArchived(state) {
            renderHistory(refs.archivedTasks, State.inCategory(state.archived, state.currentCategory), {
                empty: 'No archived tasks',
                itemClass: 'archived-item',
                contentClass: 'archived-content',
                textClass: 'archived-text',
                timeClass: 'archived-time',
                actionsClass: 'archived-actions',
                restoreClass: 'restore-btn',
                deleteClass: 'delete-archived-btn',
                timeField: 'archivedAt'
            });
        }

        function renderCompleted(state) {
            renderHistory(refs.completedTasks, State.inCategory(state.completed, state.currentCategory), {
                empty: 'No completed tasks yet',
                itemClass: 'completed-item',
                contentClass: 'completed-content',
                textClass: 'completed-text',
                timeClass: 'completed-time',
                actionsClass: 'completed-actions',
                restoreClass: 'restore-completed-btn',
                deleteClass: 'delete-completed-btn',
                timeField: 'completedAt'
            });
        }

        function updateControls(state) {
            const count = State.inCategory(state.tasks, state.currentCategory).length;
            refs.stackCount.textContent = String(count);
            refs.popButton.disabled = count === 0;
        }

        function renderAll(state) {
            renderTabs(state);
            renderStack(state);
            renderArchived(state);
            renderCompleted(state);
            updateControls(state);
        }

        return { renderAll };
    }

    const api = { create };

    global.StackTask = global.StackTask || {};
    global.StackTask.Render = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
