/*
 * Transient UI: the screen-reader live region, the toast (with an optional Undo action) and the
 * <dialog> used for text prompts and confirmations. When the page has no usable <dialog>
 * (very old browsers), prompts and confirmations fall back to window.prompt / window.confirm.
 */
(function (global) {
    'use strict';

    const TOAST_MS = 8000;

    function create(win, refs) {
        let toastTimer = null;
        let toastAction = null;
        let dialogBusy = false;

        // ---- Live region -------------------------------------------------

        function announce(message) {
            if (!refs.liveRegion) return;
            // Clearing first makes repeated identical messages be announced again
            refs.liveRegion.textContent = '';
            win.setTimeout(() => { refs.liveRegion.textContent = message; }, 30);
        }

        // ---- Toast -------------------------------------------------------

        function clearToastTimer() {
            if (toastTimer !== null) win.clearTimeout(toastTimer);
            toastTimer = null;
        }

        function hideToast() {
            clearToastTimer();
            toastAction = null;
            if (refs.toast) refs.toast.hidden = true;
        }

        function startToastTimer() {
            clearToastTimer();
            toastTimer = win.setTimeout(hideToast, TOAST_MS);
        }

        // options: { actionLabel, onAction, sticky, kind: 'info' | 'error' }
        // Errors stay until dismissed; everything else disappears after a few seconds.
        function notify(message, options) {
            const opts = options || {};
            announce(message);
            if (!refs.toast) return;
            clearToastTimer();
            toastAction = opts.onAction || null;
            refs.toastMessage.textContent = message;
            refs.toast.className = opts.kind === 'error' ? 'toast toast-error' : 'toast';
            refs.toastAction.hidden = !opts.onAction;
            if (opts.onAction) refs.toastAction.textContent = opts.actionLabel || 'Undo';
            refs.toast.hidden = false;
            if (!opts.sticky && opts.kind !== 'error') startToastTimer();
        }

        function hasUndo() {
            return toastAction !== null;
        }

        // Another change made the pending Undo meaningless
        function hideUndo() {
            if (toastAction) hideToast();
        }

        function runToastAction() {
            const action = toastAction;
            hideToast();
            if (action) action();
        }

        if (refs.toastAction) refs.toastAction.addEventListener('click', runToastAction);
        if (refs.toastClose) refs.toastClose.addEventListener('click', hideToast);
        if (refs.toast) {
            // Do not dismiss the toast while someone is reading it or reaching for Undo
            refs.toast.addEventListener('mouseenter', clearToastTimer);
            refs.toast.addEventListener('focusin', clearToastTimer);
            refs.toast.addEventListener('mouseleave', () => { if (toastAction) startToastTimer(); });
        }

        // ---- Dialog ------------------------------------------------------

        function dialogSupported() {
            return !!(refs.dialog && typeof refs.dialog.showModal === 'function');
        }

        // config: { title, message, label, value, maxLength, confirmLabel, danger, validate(value) -> error|'' }
        // Resolves to { ok, value }.
        function openDialog(config, withInput) {
            return new Promise(resolve => {
                if (dialogBusy) {
                    resolve({ ok: false, value: '' });
                    return;
                }
                dialogBusy = true;
                const { dialog, dialogForm, dialogInput, dialogError, dialogOk, dialogCancel } = refs;
                refs.dialogTitle.textContent = config.title;
                refs.dialogMessage.textContent = config.message || '';
                refs.dialogMessage.hidden = !config.message;
                refs.dialogField.hidden = !withInput;
                refs.dialogLabel.textContent = config.label || '';
                dialogInput.value = config.value || '';
                dialogInput.maxLength = config.maxLength || 100;
                dialogError.textContent = '';
                dialogOk.textContent = config.confirmLabel || 'OK';
                dialogOk.className = config.danger ? 'dialog-btn dialog-btn-danger' : 'dialog-btn dialog-btn-primary';
                dialog.returnValue = '';

                function finish() {
                    dialogForm.removeEventListener('submit', onSubmit);
                    dialogCancel.removeEventListener('click', onCancel);
                    dialog.removeEventListener('close', onClose);
                    dialog.removeEventListener('click', onBackdrop);
                    dialogBusy = false;
                    resolve({ ok: dialog.returnValue === 'ok', value: dialogInput.value });
                }
                function onSubmit(event) {
                    if (withInput && config.validate) {
                        const error = config.validate(dialogInput.value);
                        if (error) {
                            event.preventDefault();
                            dialogError.textContent = error;
                            dialogInput.focus();
                            return;
                        }
                    }
                    dialog.returnValue = 'ok';
                }
                function onCancel() { dialog.close('cancel'); }
                function onClose() { finish(); }
                // A click on the ::backdrop is reported with the dialog itself as the target
                function onBackdrop(event) { if (event.target === dialog) dialog.close('cancel'); }

                dialogForm.addEventListener('submit', onSubmit);
                dialogCancel.addEventListener('click', onCancel);
                dialog.addEventListener('close', onClose);
                dialog.addEventListener('click', onBackdrop);
                dialog.showModal();
                if (withInput) {
                    dialogInput.focus();
                    dialogInput.select();
                }
            });
        }

        // Resolves to the entered string, or null when cancelled.
        async function askText(config) {
            if (!dialogSupported()) {
                const value = win.prompt(config.label || config.title, config.value || '');
                if (value === null || value === undefined || value === '') return null;
                const error = config.validate ? config.validate(value) : '';
                if (error) {
                    notify(error, { kind: 'error' });
                    return null;
                }
                return value;
            }
            const result = await openDialog(config, true);
            return result.ok ? result.value : null;
        }

        // Resolves to true when confirmed.
        async function askConfirm(config) {
            if (!dialogSupported()) return !!win.confirm(config.message || config.title);
            const result = await openDialog(config, false);
            return result.ok;
        }

        return { announce, notify, hideToast, hideUndo, hasUndo, runToastAction, askText, askConfirm };
    }

    global.StackTask = global.StackTask || {};
    global.StackTask.Ui = { create };
})(typeof window !== 'undefined' ? window : globalThis);
