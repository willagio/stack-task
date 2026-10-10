/*
 * HTML5 drag-and-drop reordering. Listeners are delegated and registered once per container,
 * so re-rendering the list never adds or loses handlers.
 */
(function (global) {
    'use strict';

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
        makeSortable(refs.taskStack, {
            itemSelector: '.task-item',
            key: 'id',
            axis: 'y',
            draggingClass: 'dragging',
            beforeClass: 'drag-over-top',
            afterClass: 'drag-over-bottom',
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
