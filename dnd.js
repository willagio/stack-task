/*
 * Drag-and-drop reordering. Listeners are delegated and registered once per container,
 * so re-rendering the list never adds or loses handlers.
 *
 * Tasks use pointer events: the row follows the pointer and the other rows slide aside to open
 * the gap where it would land. Tabs use HTML5 drag-and-drop.
 */
(function (global) {
    'use strict';

    const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag
    const SCROLL_ZONE = 36;   // px from the list's edge where it starts to scroll

    // spec: { itemSelector, key (dataset name), draggingClass, sortingClass,
    //         onDrop(draggedKey, targetKey, above) }
    function makePointerSortable(container, spec) {
        let session = null;

        function rowGap() {
            try {
                const gap = parseFloat(global.getComputedStyle(container).rowGap);
                if (!Number.isNaN(gap)) return gap;
            } catch (e) {
                // No layout engine (tests): assume the stylesheet's gap
            }
            return 8;
        }

        function begin(event) {
            const item = session.item;
            const rect = item.getBoundingClientRect();
            let index = -1;
            session.others = [];
            Array.from(container.children).forEach((node, i) => {
                if (node.nodeType !== 1) return;
                if (node === item) { index = i; return; }
                const r = node.getBoundingClientRect();
                session.others.push({ node, index: i, center: r.top + r.height / 2, isItem: node.matches(spec.itemSelector), shift: 0 });
            });
            session.index = index;
            session.center0 = rect.top + rect.height / 2;
            session.step = rect.height + rowGap();
            session.active = true;
            item.classList.add(spec.draggingClass);
            container.classList.add(spec.sortingClass);
            if (typeof item.setPointerCapture === 'function') {
                try { item.setPointerCapture(event.pointerId); } catch (e) { /* pointer already gone */ }
            }
            if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(autoScroll);
        }

        function draggedCenter() {
            const scrolled = (container.scrollTop || 0) - session.scrollTop0;
            return session.center0 + (session.lastY - session.startY) + scrolled;
        }

        function update(clientY) {
            session.lastY = clientY;
            const dy = draggedCenter() - session.center0;
            session.item.style.transform = `translateY(${dy}px) scale(1.02)`;
            const center = draggedCenter();
            session.others.forEach(other => {
                let shift = 0;
                if (other.index > session.index && center > other.center) shift = -session.step;
                else if (other.index < session.index && center < other.center) shift = session.step;
                if (other.shift !== shift) {
                    other.shift = shift;
                    other.node.style.transform = shift ? `translateY(${shift}px)` : '';
                }
            });
        }

        // Keeps the list scrolling while the pointer rests near its top or bottom edge
        function autoScroll() {
            if (!session || !session.active) return;
            if (container.scrollHeight > container.clientHeight) {
                const rect = container.getBoundingClientRect();
                let speed = 0;
                if (session.lastY < rect.top + SCROLL_ZONE) speed = -Math.ceil((rect.top + SCROLL_ZONE - session.lastY) / 4);
                else if (session.lastY > rect.bottom - SCROLL_ZONE) speed = Math.ceil((session.lastY - (rect.bottom - SCROLL_ZONE)) / 4);
                if (speed) {
                    container.scrollTop += speed;
                    update(session.lastY);
                }
            }
            global.requestAnimationFrame(autoScroll);
        }

        // Everything slides back to where it was (CSS transitions do the motion)
        function settleBack() {
            session.item.style.transform = '';
            session.others.forEach(other => { other.node.style.transform = ''; });
        }

        function release() {
            const { item } = session;
            item.classList.remove(spec.draggingClass);
            container.classList.remove(spec.sortingClass);
            if (typeof item.releasePointerCapture === 'function') {
                try { item.releasePointerCapture(session.pointerId); } catch (e) { /* already released */ }
            }
        }

        function finish() {
            const current = session;
            release();
            const center = draggedCenter();
            const tasks = current.others.filter(other => other.isItem);
            const newBefore = tasks.filter(other => other.center < center).length;
            const oldBefore = tasks.filter(other => other.index < current.index).length;
            session = null;
            if (newBefore === oldBefore || tasks.length === 0) {
                session = current; settleBack(); session = null;
                return;
            }
            const target = newBefore < tasks.length ? tasks[newBefore] : tasks[tasks.length - 1];
            // The rows stay where they slid to: the re-render measures them there and nothing jumps
            spec.onDrop(current.item.dataset[spec.key], target.node.dataset[spec.key], newBefore < tasks.length);
            if (current.item.parentNode === container) {
                // Nothing was re-rendered (the move was refused): slide back
                session = current; settleBack(); session = null;
            }
        }

        function cancel() {
            if (!session) return;
            if (session.active) {
                release();
                settleBack();
            }
            session = null;
        }

        container.addEventListener('pointerdown', event => {
            if (session || event.button) return;
            if (event.pointerType === 'touch') return; // touch has the move buttons; a drag would fight scrolling
            const target = event.target;
            if (!target || typeof target.closest !== 'function' || target.closest('button, a, input')) return;
            const item = target.closest(spec.itemSelector);
            if (!item || !container.contains(item)) return;
            event.preventDefault(); // no text selection or focus change while dragging
            session = {
                item, pointerId: event.pointerId, startY: event.clientY, startX: event.clientX,
                lastY: event.clientY, scrollTop0: container.scrollTop || 0, active: false
            };
        });

        container.addEventListener('pointermove', event => {
            if (!session || event.pointerId !== session.pointerId) return;
            if (!session.active) {
                if (Math.abs(event.clientY - session.startY) < DRAG_THRESHOLD && Math.abs(event.clientX - session.startX) < DRAG_THRESHOLD) return;
                begin(event);
            }
            update(event.clientY);
        });

        container.addEventListener('pointerup', event => {
            if (!session || event.pointerId !== session.pointerId) return;
            if (!session.active) { session = null; return; }
            update(event.clientY);
            finish();
        });

        container.addEventListener('pointercancel', event => {
            if (session && event.pointerId === session.pointerId) cancel();
        });
    }

    // HTML5 drag-and-drop (tabs).
    // spec: { itemSelector, key (dataset name), axis: 'x'|'y',
    //         draggingClass, beforeClass, afterClass, onDrop(draggedKey, targetKey, before) }
    function makeSortable(container, spec) {
        let dragged = null;

        function itemOf(event) {
            const target = event.target;
            return target && typeof target.closest === 'function' ? target.closest(spec.itemSelector) : null;
        }

        function clearMarks(except) {
            container.querySelectorAll(spec.itemSelector).forEach(item => {
                if (item !== except) item.classList.remove(spec.beforeClass, spec.afterClass);
            });
        }

        function isBefore(event, item) {
            const rect = item.getBoundingClientRect();
            return spec.axis === 'x'
                ? event.clientX < rect.left + rect.width / 2
                : event.clientY < rect.top + rect.height / 2;
        }

        container.addEventListener('dragstart', event => {
            const item = itemOf(event);
            if (!item) return;
            dragged = item;
            // Added on the next tick so the drag image is captured before restyling
            setTimeout(() => item.classList.add(spec.draggingClass), 0);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', item.dataset[spec.key] || '');
        });

        container.addEventListener('dragend', () => {
            if (dragged) dragged.classList.remove(spec.draggingClass);
            clearMarks(null);
            dragged = null;
        });

        container.addEventListener('dragover', event => {
            const item = itemOf(event);
            if (!dragged || !item) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (item === dragged) return;
            clearMarks(item);
            const before = isBefore(event, item);
            item.classList.toggle(spec.beforeClass, before);
            item.classList.toggle(spec.afterClass, !before);
        });

        container.addEventListener('dragleave', event => {
            const item = itemOf(event);
            if (item && !item.contains(event.relatedTarget)) {
                item.classList.remove(spec.beforeClass, spec.afterClass);
            }
        });

        container.addEventListener('drop', event => {
            const item = itemOf(event);
            if (!dragged || !item) return;
            event.preventDefault();
            item.classList.remove(spec.beforeClass, spec.afterClass);
            if (item === dragged) return;
            spec.onDrop(dragged.dataset[spec.key], item.dataset[spec.key], isBefore(event, item));
        });
    }

    // handlers: { onReorderTasks(draggedId, targetId, above), onReorderCategories(dragged, target, before) }
    function attach(refs, handlers) {
        makePointerSortable(refs.taskStack, {
            itemSelector: '.task-item',
            key: 'id',
            draggingClass: 'dragging',
            sortingClass: 'sorting',
            onDrop: handlers.onReorderTasks
        });
        makeSortable(refs.tabsList, {
            itemSelector: '.tab',
            key: 'category',
            axis: 'x',
            draggingClass: 'dragging-tab',
            beforeClass: 'drag-over-left',
            afterClass: 'drag-over-right',
            onDrop: handlers.onReorderCategories
        });
    }

    global.StackTask = global.StackTask || {};
    global.StackTask.Dnd = { attach };
})(typeof window !== 'undefined' ? window : globalThis);
