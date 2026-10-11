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
        ] },
        up: { size: 14, shapes: [
            ['path', { d: 'M3.5 8.5L7 5L10.5 8.5', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
        ] },
        down: { size: 14, shapes: [
            ['path', { d: 'M3.5 5.5L7 9L10.5 5.5', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
        ] },
        play: { size: 14, shapes: [
            ['path', { d: 'M4.5 3L11 7L4.5 11Z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }]
        ] },
        pause: { size: 14, shapes: [
            ['path', { d: 'M4.5 3V11M9.5 3V11', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]
        ] }
    };

    // Task text inside accessible names: short, and never empty
    function shorten(text) {
        const flat = String(text).replace(/\s+/g, ' ').trim();
        return flat.length > 40 ? flat.slice(0, 39) + '…' : flat;
    }

    function create(doc, refs) {
        // The Done button lives in the input section until a task exists; then it moves into the top card
        const popHome = refs.popButton ? refs.popButton.parentNode : null;

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
            svg.setAttribute('focusable', 'false');
            def.shapes.forEach(([tag, attrs]) => {
                const shape = doc.createElementNS(SVG_NS, tag);
                Object.keys(attrs).forEach(key => shape.setAttribute(key, attrs[key]));
                svg.appendChild(shape);
            });
            return svg;
        }

        function iconButton(className, iconName, label, data, disabled) {
            const attrs = { type: 'button', title: label, 'aria-label': label };
            if (disabled) attrs.disabled = '';
            const button = el('button', { class: className, attrs, data }, [icon(iconName)]);
            if (disabled) button.disabled = true;
            return button;
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
            const tabs = state.categories.map((category, index) => {
                const active = category === state.currentCategory;
                return el('div', {
                    class: active ? 'tab tab-active' : 'tab',
                    attrs: { draggable: 'true', role: 'presentation' },
                    data: { category }
                }, [
                    el('button', {
                        class: 'tab-button',
                        attrs: {
                            type: 'button',
                            role: 'tab',
                            id: `tab-${index}`,
                            'aria-selected': active ? 'true' : 'false',
                            'aria-controls': 'taskPanel',
                            tabindex: active ? '0' : '-1'
                        },
                        data: { category }
                    }, [el('span', { class: 'tab-name', text: category })])
                ]);
            });
            refs.tabsList.replaceChildren(...tabs);
            if (refs.taskPanel) {
                const activeIndex = state.categories.indexOf(state.currentCategory);
                refs.taskPanel.setAttribute('aria-labelledby', `tab-${activeIndex}`);
            }
        }

        function reducedMotion() {
            const win = doc.defaultView;
            try {
                return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
            } catch (e) {
                return false;
            }
        }

        function stackItems(container) {
            return Array.from(container.children).filter(node => node.dataset && node.dataset.id !== undefined);
        }

        // FLIP: where each item was before a re-render, so it can slide to its new place
        function snapshotStack(container) {
            const before = new Map();
            stackItems(container).forEach(node => {
                if (typeof node.getBoundingClientRect !== 'function') return;
                before.set(node.dataset.id, { rect: node.getBoundingClientRect(), top: node.classList.contains('top-task') });
            });
            return before;
        }

        function animateStack(container, before) {
            if (reducedMotion()) return;
            stackItems(container).forEach(node => {
                if (typeof node.animate !== 'function') return;
                const prev = before.get(node.dataset.id);
                if (!prev) {
                    node.animate(
                        [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }],
                        { duration: 240, easing: 'ease-out' }
                    );
                    return;
                }
                const isTop = node.classList.contains('top-task');
                if (isTop && !prev.top) node.classList.add('became-top');
                const next = node.getBoundingClientRect();
                const dy = prev.rect.top - next.top;
                const dh = prev.rect.height - next.height;
                if (Math.abs(dy) < 1 && Math.abs(dh) < 1) return;
                const from = { transform: `translateY(${dy}px)` };
                const to = { transform: 'none' };
                if (Math.abs(dh) >= 1) {
                    from.height = from.minHeight = `${prev.rect.height}px`;
                    to.height = to.minHeight = `${next.height}px`;
                }
                node.animate([from, to], { duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
            });
        }

        // "0:42" while a timer runs or once time was logged; nothing for an untouched task
        function timeLabel(task, now) {
            const running = State.isRunning(task);
            const elapsed = State.elapsedMs(task, now);
            if (!running && elapsed <= 0) return null;
            return el('span', {
                class: running ? 'task-time running' : 'task-time',
                text: State.formatClock(elapsed),
                attrs: { title: running ? 'Timer running' : 'Time spent' },
                data: { timeFor: task.id }
            });
        }

        function renderStack(state) {
            const visible = State.inCategory(state.tasks, state.currentCategory);
            if (visible.length === 0) {
                if (popHome) {
                    popHome.appendChild(refs.popButton);
                    refs.popButton.setAttribute('aria-label', 'Done');
                }
                refs.taskStack.replaceChildren(emptyState('No tasks in stack', 'Type one above and press Enter.'));
                return;
            }
            const now = Date.now();
            const before = snapshotStack(refs.taskStack);
            // Top of the stack first
            const items = visible.map((task, index) => {
                const isTop = index === visible.length - 1;
                const name = shorten(task.text);
                const data = id => ({ id: task.id, action: id });
                // The top task carries no label: its size and the "Up next" divider below it say what it is
                const running = State.isRunning(task);
                const children = [
                    el('div', { class: 'drag-handle', attrs: { 'aria-hidden': 'true' } }, [icon('grip')]),
                    el('div', { class: 'task-text', text: task.text, attrs: { title: task.text } })
                ];
                // Elapsed time shows on the top task and on whichever timer is running; paused time on lower rows stays out of sight
                const time = (isTop || running) ? timeLabel(task, now) : null;
                if (time) children.push(time);
                const timerLabel = running ? `Pause timer for "${name}"` : `Start timer for "${name}"`;
                const timerBtn = iconButton(running ? 'task-action-btn timer-btn running' : 'task-action-btn timer-btn',
                    running ? 'pause' : 'play', timerLabel, data('timer'));
                const actions = [
                    iconButton('task-action-btn move-up-btn', 'up', `Move "${name}" up`, data('up'), isTop),
                    iconButton('task-action-btn move-down-btn', 'down', `Move "${name}" down`, data('down'), index === 0),
                    iconButton('task-action-btn archive-btn', 'archive', `Archive "${name}"`, data('archive')),
                    iconButton('task-action-btn remove-btn', 'close', `Delete "${name}"`, data('remove'))
                ];
                if (isTop) {
                    // The one thing to do now: Start and Done sit right next to it
                    timerBtn.classList.add('with-label');
                    timerBtn.appendChild(el('span', { text: running ? 'Pause' : 'Start' }));
                    refs.popButton.setAttribute('aria-label', `Done: "${name}"`);
                    children.push(el('div', { class: 'task-actions' }, actions));
                    children.push(el('div', { class: 'now-actions' }, [timerBtn, refs.popButton]));
                } else {
                    // Lower rows stay quiet: a timer button only while that timer is running
                    if (running) actions.unshift(timerBtn);
                    children.push(el('div', { class: 'task-actions' }, actions));
                }
                return el('div', {
                    class: isTop ? 'task-item top-task' : 'task-item',
                    attrs: { role: 'listitem' },
                    data: { id: task.id }
                }, children);
            }).reverse();
            if (items.length > 1) {
                const rest = items.length - 1;
                items.splice(1, 0, el('div', {
                    class: 'stack-divider',
                    text: `Up next · ${rest}`,
                    attrs: { 'aria-hidden': 'true' }
                }));
            }
            refs.taskStack.replaceChildren(...items);
            animateStack(refs.taskStack, before);
        }

        function renderHistory(container, tasks, spec) {
            if (tasks.length === 0) {
                container.replaceChildren(emptyState(spec.empty));
                return;
            }
            container.replaceChildren(...tasks.map(task => {
                const name = shorten(task.text);
                const spent = State.elapsedMs(task, 0);
                const when = State.formatTime(task[spec.timeField]);
                return el('div', {
                    class: `history-item ${spec.itemClass}`,
                    attrs: { role: 'listitem' },
                    data: { id: task.id }
                }, [
                    el('div', { class: `history-content ${spec.contentClass}` }, [
                        el('div', { class: `history-text ${spec.textClass}`, text: task.text }),
                        el('div', { class: `history-time ${spec.timeClass}`, text: spent > 0 ? `${when} · ${State.formatDuration(spent)}` : when })
                    ]),
                    el('div', { class: `history-actions ${spec.actionsClass}` }, [
                        iconButton(`history-btn ${spec.restoreClass}`, 'restore', `Restore "${name}" to the stack`, { id: task.id }),
                        iconButton(`history-btn history-delete ${spec.deleteClass}`, 'close', `Delete "${name}" permanently`, { id: task.id })
                    ])
                ]);
            }));
        }

        function renderArchived(state) {
            const tasks = State.inCategory(state.archived, state.currentCategory);
            if (refs.archivedCount) refs.archivedCount.textContent = String(tasks.length);
            renderHistory(refs.archivedTasks, tasks, {
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
            const tasks = State.inCategory(state.completed, state.currentCategory);
            if (refs.completedCount) refs.completedCount.textContent = String(tasks.length);
            renderHistory(refs.completedTasks, tasks, {
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
            if (refs.stackLabel) refs.stackLabel.textContent = count === 1 ? 'task' : 'tasks';
            refs.popButton.disabled = count === 0;
            if (refs.renameCategoryBtn) refs.renameCategoryBtn.disabled = false;
            if (refs.deleteCategoryBtn) refs.deleteCategoryBtn.disabled = state.categories.length <= 1;
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
