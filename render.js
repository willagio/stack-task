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
        tomato: { size: 18, shapes: [
            ['circle', { cx: 9, cy: 10.5, r: 6.5, fill: '#E0442B' }],
            ['path', { d: 'M9 5.5C7.5 2.5 4.5 3 3.5 4.5C5 6.5 7.5 6.5 9 5.5ZM9 5.5C10.5 2.5 13.5 3 14.5 4.5C13 6.5 10.5 6.5 9 5.5Z', fill: '#1F6B38' }]
        ] }
    };

    // Task text inside accessible names: short, and never empty
    function shorten(text) {
        const flat = String(text).replace(/\s+/g, ' ').trim();
        return flat.length > 40 ? flat.slice(0, 39) + '…' : flat;
    }

    const FIVE_MINUTES = 5 * 60 * 1000;
    const TALLY_MAX = 4;
    // Circumference of the wedge circle in index.html (r = 22): the visible part of its stroke is the time left
    const WEDGE = 2 * Math.PI * 22;

    // What the hero says about the top task, from its timer alone
    function statusOf(task, now) {
        if (State.isRunning(task)) {
            return State.remainingMs(task, now) <= FIVE_MINUTES
                ? { key: 'almost', text: 'Almost ripe.' }
                : { key: 'running', text: 'Ripening…' };
        }
        if (State.isRipe(task)) return { key: 'ripe', text: 'Ripe! Take five, then Done — or one more?' };
        if (State.elapsedMs(task, now) > 0) return { key: 'half', text: 'Half-ripe. Keep going?' };
        return { key: 'fresh', text: 'Fresh tomato. Start?' };
    }

    function sameDay(value, now) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return false;
        const today = new Date(now);
        return date.getFullYear() === today.getFullYear()
            && date.getMonth() === today.getMonth()
            && date.getDate() === today.getDate();
    }

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
                before.set(node.dataset.id, node.getBoundingClientRect());
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
                const next = node.getBoundingClientRect();
                const dy = prev.top - next.top;
                const dh = prev.height - next.height;
                if (Math.abs(dy) < 1 && Math.abs(dh) < 1) return;
                const from = { transform: `translateY(${dy}px)` };
                const to = { transform: 'none' };
                if (Math.abs(dh) >= 1) {
                    from.height = from.minHeight = `${prev.height}px`;
                    to.height = to.minHeight = `${next.height}px`;
                }
                node.animate([from, to], { duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
            });
        }

        // ---- Hero: the one task to do now ---------------------------------

        let heroId = null;

        function tomatoTally(count) {
            const shown = count > TALLY_MAX ? 1 : count;
            const nodes = [];
            for (let i = 0; i < shown; i++) nodes.push(icon('tomato'));
            if (count > TALLY_MAX) nodes.push(el('span', { class: 'tally-count', text: `×${count}` }));
            return nodes;
        }

        // Clock, wedge, tilt and status: everything that changes while a timer runs. Cheap enough for every tick.
        function paintDial(state, now) {
            const index = State.topTaskIndex(state);
            if (index === -1) return;
            const task = state.tasks[index];
            const at = now === undefined ? Date.now() : now;
            const remaining = State.remainingMs(task, at);
            const status = statusOf(task, at);
            refs.heroClock.textContent = State.formatRemaining(remaining);
            const minutes = Math.ceil(remaining / 60000);
            const label = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
            if (refs.heroClock.getAttribute('aria-label') !== label) refs.heroClock.setAttribute('aria-label', label);
            // The wedge is set as an attribute: no transition, one step per second
            const visible = Math.max(0, Math.min(1, remaining / State.POMODORO_MS)) * WEDGE;
            refs.dialArc.setAttribute('stroke-dasharray', `${visible.toFixed(2)} ${WEDGE.toFixed(2)}`);
            refs.dial.classList.toggle('tilt', remaining <= FIVE_MINUTES && State.elapsedMs(task, at) > 0);
            refs.heroStatus.textContent = status.text;
            refs.heroTask.dataset.phase = status.key;
        }

        function renderHero(state, now) {
            const visible = State.inCategory(state.tasks, state.currentCategory);
            if (visible.length === 0) {
                heroId = null;
                refs.heroTask.hidden = true;
                refs.heroEmpty.hidden = false;
                refs.thenLine.hidden = true;
                refs.popButton.disabled = true;
                const today = State.inCategory(state.completed, state.currentCategory)
                    .filter(task => sameDay(task.completedAt, now));
                if (today.length > 0) {
                    const ripe = today.reduce((sum, task) => sum + State.ripeCount(task, 0), 0);
                    refs.emptyTitle.textContent = "Plate's clean.";
                    refs.emptySub.textContent = `${today.length} done today${ripe > 0 ? ' · ' : ''}`;
                    if (ripe > 0) tomatoTally(ripe).forEach(node => refs.emptySub.appendChild(node));
                } else {
                    refs.emptyTitle.textContent = 'Empty plate.';
                    refs.emptySub.textContent = "What's the one thing?";
                }
                return;
            }
            const rest = visible.slice(0, -1);
            const task = visible[visible.length - 1];
            const name = shorten(task.text);
            const running = State.isRunning(task);
            const ripe = State.isRipe(task);
            const card = refs.heroTask;
            const changed = heroId !== null && !State.sameId(heroId, task.id);
            heroId = task.id;
            refs.heroEmpty.hidden = true;
            card.hidden = false;
            card.dataset.id = task.id;
            // A rename in progress owns the text node until it finishes
            if (!card.classList.contains('editing')) {
                refs.heroText.textContent = task.text;
                refs.heroText.setAttribute('title', task.text);
            }
            refs.timerButton.dataset.id = task.id;
            refs.timerButton.classList.toggle('running', running);
            const verb = running ? 'Pause' : (ripe ? 'One more' : 'Start');
            refs.timerLabel.textContent = verb;
            const timerLabel = running ? `Pause timer for "${name}"` : (ripe ? `Start one more tomato for "${name}"` : `Start timer for "${name}"`);
            refs.timerButton.setAttribute('aria-label', timerLabel);
            refs.timerButton.setAttribute('title', timerLabel);
            refs.popButton.disabled = false;
            refs.popButton.setAttribute('aria-label', `Done: "${name}"`);
            [['down', `Move "${name}" down`, rest.length === 0], ['archive', `Archive "${name}"`, false], ['remove', `Delete "${name}"`, false]]
                .forEach(([action, label, disabled]) => {
                    const button = card.querySelector(action === 'down' ? '.move-down-btn' : (action === 'archive' ? '.archive-btn' : '.remove-btn'));
                    button.dataset.id = task.id;
                    button.setAttribute('title', label);
                    button.setAttribute('aria-label', label);
                    button.disabled = disabled;
                });

            const ripened = State.ripeCount(task, now);
            refs.heroTally.hidden = ripened === 0;
            refs.heroTally.setAttribute('aria-label', `${ripened} ${ripened === 1 ? 'tomato' : 'tomatoes'} ripened`);
            refs.heroTally.replaceChildren(...tomatoTally(ripened));
            paintDial(state, now);

            if (rest.length === 0) {
                refs.thenLine.hidden = false;
                refs.thenLink.hidden = true;
                refs.thenNone.hidden = false;
            } else {
                const next = rest[rest.length - 1];
                refs.thenLine.hidden = false;
                refs.thenNone.hidden = true;
                refs.thenLink.hidden = false;
                refs.thenLink.replaceChildren(
                    el('span', { class: 'then-label', text: 'Then: ' }),
                    el('span', { class: 'then-name', text: next.text }),
                    ...(rest.length > 1 ? [el('span', { class: 'then-more', text: ` · +${rest.length - 1}` })] : [])
                );
                refs.thenLink.setAttribute('aria-label', `Then: ${shorten(next.text)}${rest.length > 1 ? `, and ${rest.length - 1} more` : ''}. Jump to the list.`);
            }
            // The next task slides in from the right when the one before it is gone
            if (changed && !reducedMotion()) {
                card.classList.remove('became-top');
                if (typeof card.getBoundingClientRect === 'function') card.getBoundingClientRect();
                card.classList.add('became-top');
            }
        }

        // Everything below the hero: the tasks that wait their turn
        function renderStack(state) {
            const visible = State.inCategory(state.tasks, state.currentCategory);
            const rest = visible.slice(0, -1);
            refs.stackRest.hidden = rest.length === 0;
            const before = snapshotStack(refs.taskStack);
            // Next task first
            const items = rest.map((task, index) => {
                const name = shorten(task.text);
                const data = action => ({ id: task.id, action });
                return el('div', {
                    class: 'task-item',
                    attrs: { role: 'listitem' },
                    data: { id: task.id }
                }, [
                    el('div', { class: 'drag-handle', attrs: { 'aria-hidden': 'true' } }, [icon('grip')]),
                    el('div', { class: 'task-text', text: task.text, attrs: { title: task.text } }),
                    el('div', { class: 'task-actions' }, [
                        iconButton('task-action-btn move-up-btn', 'up', `Move "${name}" up`, data('up')),
                        iconButton('task-action-btn move-down-btn', 'down', `Move "${name}" down`, data('down'), index === 0),
                        iconButton('task-action-btn archive-btn', 'archive', `Archive "${name}"`, data('archive')),
                        iconButton('task-action-btn remove-btn', 'close', `Delete "${name}"`, data('remove'))
                    ])
                ]);
            }).reverse();
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
            if (refs.renameCategoryBtn) refs.renameCategoryBtn.disabled = false;
            if (refs.deleteCategoryBtn) refs.deleteCategoryBtn.disabled = state.categories.length <= 1;
        }

        function renderAll(state) {
            const now = Date.now();
            renderTabs(state);
            renderHero(state, now);
            renderStack(state);
            renderArchived(state);
            renderCompleted(state);
            updateControls(state);
        }

        return { renderAll, paintDial };
    }

    const api = { create };

    global.StackTask = global.StackTask || {};
    global.StackTask.Render = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
