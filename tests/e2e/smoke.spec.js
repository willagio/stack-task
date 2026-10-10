// Browser smoke test. Run with `npm run test:e2e` (needs `npm install` and
// `npx playwright install chromium`). Every test fails on any console error or uncaught page error.
// Covers: add / complete / delete (with Undo) / reload, export / import, data from the original version,
// keyboard use, and a phone-sized touch viewport.
const { test, expect, devices } = require('@playwright/test');
const fs = require('node:fs');

// A fileDB blob exactly as written by the first version of the app, plus the old duplicate keys.
const ORIGINAL_FILEDB = JSON.stringify({
    tasks: [
        { text: 'Write report', id: 1700000000001, createdAt: '2024-01-05T10:00:00.000Z', category: 'Work' },
        { text: 'Buy milk', id: 1700000000002, createdAt: '2024-01-05T10:05:00.000Z', category: 'Personal' },
        { text: 'Email "Bob" & <team>', id: 1700000000003, createdAt: '2024-01-05T10:06:00.000Z', category: 'Work' }
    ],
    completed: [{ text: 'Done thing', id: 1700000000004, createdAt: '2024-01-04T09:00:00.000Z', category: 'Personal', completedAt: '2024-01-04T12:00:00.000Z' }],
    archived: [{ text: 'Maybe later', id: 1700000000005, createdAt: '2024-01-03T09:00:00.000Z', category: 'Work', archivedAt: '2024-01-03T12:00:00.000Z' }],
    categories: ['Work', 'Personal']
});

let problems;

test.beforeEach(async ({ page }) => {
    problems = [];
    page.on('console', msg => { if (msg.type() === 'error') problems.push('console: ' + msg.text()); });
    page.on('pageerror', err => problems.push('pageerror: ' + err.message));
    // Fonts come from a CDN and are not available in sandboxes; they are not part of the app logic
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
});

test.afterEach(() => {
    expect(problems).toEqual([]);
});

async function addTask(page, text) {
    await page.locator('#taskInput').fill(text);
    await page.locator('#taskInput').press('Enter');
}

const topTask = page => page.locator('#taskStack .top-task .task-text');

test('add, complete, delete, and reload restores', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#popButton')).toBeDisabled();

    await addTask(page, 'first');
    await addTask(page, 'second');
    await addTask(page, 'third');
    await expect(topTask(page)).toHaveText('third');
    await expect(page.locator('.stack-count')).toHaveText('3');

    // complete (pop) the top task
    await page.locator('#popButton').click();
    await expect(topTask(page)).toHaveText('second');
    await page.locator('.completed-section .section-toggle').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['third']);

    // delete the top task: immediate, no dialog, with an Undo toast
    let dialogs = 0;
    page.on('dialog', dialog => { dialogs++; dialog.dismiss(); });
    await page.locator('#taskStack .top-task').hover();
    await page.locator('#taskStack .top-task .remove-btn').click();
    await expect(topTask(page)).toHaveText('first');
    await expect(page.locator('#toast')).toContainText('Deleted "second"');
    await page.locator('#toastAction').click();
    await expect(topTask(page)).toHaveText('second');
    await page.locator('#taskStack .top-task').hover();
    await page.locator('#taskStack .top-task .remove-btn').click();
    await expect(topTask(page)).toHaveText('first');
    expect(dialogs).toBe(0);

    await page.reload();
    await expect(topTask(page)).toHaveText('first');
    await page.locator('.completed-section .section-toggle').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['third']);
});

test('pop only completes tasks of the current category', async ({ page }) => {
    await page.goto('/');
    await addTask(page, 'work task');
    await page.locator('.tab', { hasText: 'Personal' }).click();
    await addTask(page, 'personal task');
    await page.locator('.tab', { hasText: 'Work' }).click();
    await page.locator('#popButton').click();
    await expect(page.locator('#popButton')).toBeDisabled();
    await page.locator('.tab', { hasText: 'Personal' }).click();
    await expect(topTask(page)).toHaveText('personal task');
});

test('export then import restores the same data', async ({ page }, testInfo) => {
    await page.goto('/');
    await addTask(page, 'keep me');
    await addTask(page, 'done me');
    await page.locator('#popButton').click();

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#exportBtn').click()
    ]);
    const file = testInfo.outputPath('backup.json');
    await download.saveAs(file);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(exported.tasks.map(t => t.text)).toEqual(['keep me']);
    expect(exported.completed.map(t => t.text)).toEqual(['done me']);

    // wipe, then import the backup
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('#taskStack .task-item')).toHaveCount(0);
    await page.locator('#importFile').setInputFiles(file);
    await expect(page.locator('#dialog')).toBeVisible();
    await expect(page.locator('#dialogMessage')).toContainText('Replace your current tasks');
    await page.locator('#dialogOk').click();
    await expect(topTask(page)).toHaveText('keep me');
    await page.locator('.completed-section .section-toggle').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['done me']);

    await page.reload();
    await expect(topTask(page)).toHaveText('keep me');
});

test('invalid import is rejected and leaves data untouched', async ({ page }, testInfo) => {
    await page.goto('/');
    await addTask(page, 'precious');
    const bad = testInfo.outputPath('bad.json');
    fs.writeFileSync(bad, JSON.stringify({ tasks: [{ text: '<img src=x onerror=alert(1)>', id: '"><img src=x>' }] }));

    await page.locator('#importFile').setInputFiles(bad);
    await expect(page.locator('#toast')).toContainText('Import failed');
    await expect(page.locator('#dialog')).toBeHidden();
    await expect(topTask(page)).toHaveText('precious');
    await page.reload();
    await expect(topTask(page)).toHaveText('precious');
});

test('malicious text is shown as text, never executed', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
        window.__xss = false;
        localStorage.setItem('fileDB', JSON.stringify({
            tasks: [{ text: '<img src=x onerror="window.__xss=true">', id: 'a1', category: 'Work" onmouseover="window.__xss=true' }],
            completed: [], archived: [], categories: ['Work" onmouseover="window.__xss=true']
        }));
    });
    await page.reload();
    await expect(topTask(page)).toHaveText('<img src=x onerror="window.__xss=true">');
    await expect(page.locator('#taskStack img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeFalsy();
});

test('data written by the original version loads, with the selected tab kept', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(raw => {
        localStorage.clear();
        localStorage.setItem('fileDB', raw);
        localStorage.setItem('currentCategory', 'Personal'); // old duplicate key
    }, ORIGINAL_FILEDB);
    await page.reload();
    await expect(page.locator('.tab-active .tab-name')).toHaveText('Personal');
    await expect(topTask(page)).toHaveText('Buy milk');
    await page.locator('.tab', { hasText: 'Work' }).click();
    await expect(topTask(page)).toHaveText('Email "Bob" & <team>');
    await page.locator('.completed-section .section-toggle').click();
    await page.locator('.tab', { hasText: 'Personal' }).click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['Done thing']);
    // numeric ids survive a round trip through the new storage module
    await addTask(page, 'new one');
    const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).tasks.map(t => t.id));
    expect(ids.slice(0, 3)).toEqual([1700000000001, 1700000000002, 1700000000003]);
});

test('original data beyond today\'s input limits, plus one bad item, loads without loss', async ({ page }) => {
    const longText = 'Long note. '.repeat(600).slice(0, 6000);
    const longCategory = `"Q4" <b>plans</b> & 'stuff' ${'x'.repeat(120)}`.slice(0, 120);
    const raw = JSON.stringify({
        tasks: [
            { text: 'Write report', id: 1700000000001, createdAt: '2024-01-05T10:00:00.000Z', category: 'Work' },
            { text: longText, id: 1700000000002, createdAt: '2024-01-05T10:05:00.000Z', category: 'Work' },
            { text: 'In the long tab', id: 1700000000003, createdAt: '2024-01-05T10:06:00.000Z', category: longCategory },
            { id: 1700000000009, category: 'Work' } // no text: the only item that is dropped
        ],
        completed: [{ text: 'Done in long tab', id: 1700000000004, createdAt: '2024-01-04T09:00:00.000Z', category: longCategory, completedAt: '2024-01-04T12:00:00.000Z' }],
        archived: [],
        categories: ['Work', 'Personal', longCategory]
    });
    await page.goto('/');
    await page.evaluate(value => { localStorage.clear(); localStorage.setItem('fileDB', value); }, raw);
    await page.reload();

    await expect(page.locator('#toast')).toContainText('1 unreadable item skipped');
    await expect(page.locator('.tab .tab-name')).toHaveText(['Work', 'Personal', longCategory]);
    await expect(page.locator('#taskStack .task-text')).toHaveText([longText, 'Write report']);
    await page.locator('.tab', { hasText: 'Q4' }).click();
    await expect(topTask(page)).toHaveText('In the long tab');
    await page.locator('.completed-section .section-toggle').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['Done in long tab']);

    // after an action, fileDB still holds everything; the untouched original is in the backup
    await addTask(page, 'new one');
    const stored = await page.evaluate(() => {
        const backups = Object.keys(localStorage).filter(k => k.startsWith('fileDB.backup-'));
        return { db: JSON.parse(localStorage.getItem('fileDB')), backup: backups.map(k => localStorage.getItem(k)) };
    });
    expect(stored.db.tasks.map(t => t.text)).toEqual(['Write report', longText, 'In the long tab', 'new one']);
    expect(stored.db.tasks.slice(0, 3).map(t => t.id)).toEqual([1700000000001, 1700000000002, 1700000000003]);
    expect(stored.db.completed.map(t => t.text)).toEqual(['Done in long tab']);
    expect(stored.db.categories).toEqual(['Work', 'Personal', longCategory]);
    expect(stored.backup).toEqual([raw]);

    // the warning was shown once: a reload is quiet
    await page.reload();
    await expect(page.locator('.tab-active .tab-name')).toHaveText(longCategory);
    await expect(page.locator('#toast')).toBeHidden();
});

test('legacy-only keys (no fileDB) are migrated', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('taskStack', JSON.stringify([{ text: 'legacy task', id: 1, createdAt: '2024-01-01T00:00:00.000Z', category: 'Personal' }]));
        localStorage.setItem('categories', JSON.stringify(['Work', 'Personal']));
        localStorage.setItem('currentCategory', 'Personal');
    });
    await page.reload();
    await expect(page.locator('.tab-active .tab-name')).toHaveText('Personal');
    await expect(topTask(page)).toHaveText('legacy task');
});

test('keyboard: Add button, tab arrows, move buttons, live announcements', async ({ page }) => {
    await page.goto('/');
    await page.locator('#taskInput').fill('first');
    await page.locator('#addTaskBtn').click();
    await page.locator('#taskInput').fill('second');
    await page.locator('#addTaskBtn').click();
    await expect(topTask(page)).toHaveText('second');
    await expect(page.locator('#liveRegion')).toContainText('Added "second" to Work. 2 tasks in the stack.');

    // reorder with the keyboard only
    const item = text => page.locator('#taskStack .task-item', { hasText: text });
    await item('first').locator('.move-up-btn').focus();
    await page.keyboard.press('Enter');
    await expect(topTask(page)).toHaveText('first');
    await expect(page.locator('#liveRegion')).toContainText('Moved "first" up. Position 1 of 2.');
    await expect(page.locator(':focus')).toHaveClass(/move-down-btn/); // "up" is disabled now, focus stays in the row

    // the action buttons show up with keyboard focus alone (no hover)
    await item('second').locator('.archive-btn').focus();
    await expect(item('second').locator('.task-actions')).toHaveCSS('opacity', '1');
    // the focus ring is drawn
    expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).toBe('solid');

    // tabs: roles, roving tabindex, arrow keys
    await expect(page.locator('[role=tablist] [role=tab]')).toHaveCount(2);
    await page.locator('[role=tab][aria-selected=true]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Personal');
    await expect(page.locator('[role=tab][aria-selected=true]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Work');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.tab-name')).toHaveText(['Personal', 'Work']);

    // collapsible sections are buttons and hidden content is not reachable
    const toggle = page.locator('.archive-section .section-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#archivedTasks')).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#archivedTasks')).toBeVisible();
});

test('dialogs: add, rename and delete a category (with Undo), validation inside the dialog', async ({ page }) => {
    await page.goto('/');
    await addTask(page, 'work thing');

    await page.locator('#addCategoryBtn').click();
    await expect(page.locator('#dialog')).toBeVisible();
    await expect(page.locator('#dialogInput')).toBeFocused();
    await page.locator('#dialogInput').fill('work'); // clashes case-insensitively
    await page.locator('#dialogOk').click();
    await expect(page.locator('#dialogError')).toContainText('already exists');
    await expect(page.locator('#dialog')).toBeVisible();
    await page.locator('#dialogInput').fill('Home');
    await page.keyboard.press('Enter');
    await expect(page.locator('#dialog')).toBeHidden();
    await expect(page.locator('.tab-active .tab-name')).toHaveText('Home');

    // Escape cancels
    await page.locator('#renameCategoryBtn').click();
    await expect(page.locator('#dialogInput')).toHaveValue('Home');
    await page.keyboard.press('Escape');
    await expect(page.locator('#dialog')).toBeHidden();
    await expect(page.locator('.tab-active .tab-name')).toHaveText('Home');

    // rename without double-click
    await page.locator('#renameCategoryBtn').click();
    await page.locator('#dialogInput').fill('Errands');
    await page.locator('#dialogOk').click();
    await expect(page.locator('.tab-active .tab-name')).toHaveText('Errands');

    // delete is immediate and undoable
    await page.locator('#deleteCategoryBtn').click();
    await expect(page.locator('.tab-name')).toHaveText(['Work', 'Personal']);
    await page.locator('#toastAction').click();
    await expect(page.locator('.tab-name')).toHaveText(['Work', 'Personal', 'Errands']);
    await page.reload();
    await expect(page.locator('.tab-name')).toHaveText(['Work', 'Personal', 'Errands']);
});

test('mouse drag and drop still reorders tasks and categories', async ({ page }) => {
    await page.goto('/');
    for (const text of ['a', 'b', 'c']) await addTask(page, text);   // displayed c, b, a
    const item = text => page.locator('#taskStack .task-item', { hasText: new RegExp('^' + text + '(?![a-z])') });
    await item('a').dragTo(item('c'), { targetPosition: { x: 100, y: 5 } }); // upper half of the top row
    await expect(topTask(page)).toHaveText('a');
    await expect(page.locator('#taskStack .task-text')).toHaveText(['a', 'c', 'b']);

    await page.locator('.tab', { hasText: 'Personal' }).dragTo(page.locator('.tab', { hasText: 'Work' }), { targetPosition: { x: 5, y: 10 } });
    await expect(page.locator('.tab-name')).toHaveText(['Personal', 'Work']);
    await page.reload();
    await expect(page.locator('.tab-name')).toHaveText(['Personal', 'Work']);
    await page.locator('.tab', { hasText: 'Work' }).click();
    await expect(page.locator('#taskStack .task-text')).toHaveText(['a', 'c', 'b']);
});

test('the app works when Google Fonts cannot be loaded', async ({ page }) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    const started = Date.now();
    await page.goto('/', { waitUntil: 'load' });
    expect(Date.now() - started).toBeLessThan(5000);
    await addTask(page, 'offline task');
    await expect(topTask(page)).toHaveText('offline task');
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toContain('system-ui');
    // the browser reports the blocked CDN requests as console errors; they are expected here
    problems = problems.filter(p => !/ERR_FAILED|fonts\.(googleapis|gstatic)/.test(p));
});

test('reduced motion turns transitions and animations off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await addTask(page, 'calm');
    const duration = await page.evaluate(() => getComputedStyle(document.querySelector('#popButton')).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.001);
});

test.describe('phone-sized touch viewport', () => {
    const { defaultBrowserType, ...phone } = devices['Pixel 7'];
    test.use(phone);

    test('layout, touch targets and the full add / complete / undo flow', async ({ page }) => {
        await page.goto('/');
        expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);

        await page.locator('#taskInput').fill('call the bank');
        await page.locator('#addTaskBtn').tap();
        await addTask(page, 'pick up the parcel');
        await expect(topTask(page)).toHaveText('pick up the parcel');

        // the page itself scrolls and nothing overflows sideways
        const metrics = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            height: document.querySelector('.app').getBoundingClientRect().height,
            viewport: window.innerHeight,
            inputFont: parseFloat(getComputedStyle(document.querySelector('#taskInput')).fontSize)
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
        expect(metrics.height).toBeGreaterThanOrEqual(metrics.viewport);
        expect(metrics.inputFont).toBeGreaterThanOrEqual(16); // avoids the iOS focus zoom

        // row actions are visible without hovering, and every control is at least 44px
        await expect(page.locator('#taskStack .top-task .task-actions')).toHaveCSS('opacity', '1');
        const selectors = ['#addTaskBtn', '#popButton', '#taskInput', '#addCategoryBtn', '#renameCategoryBtn',
            '#deleteCategoryBtn', '.tab-button', '.section-toggle', '#exportBtn', '#importBtn',
            '#taskStack .task-item:nth-child(2) .task-action-btn'];
        for (const selector of selectors) {
            const handles = await page.locator(selector).elementHandles();
            expect(handles.length, selector + ' exists').toBeGreaterThan(0);
            for (const handle of handles) {
                const box = await handle.boundingBox();
                expect(box.width, selector + ' width').toBeGreaterThanOrEqual(43.5);
                expect(box.height, selector + ' height').toBeGreaterThanOrEqual(43.5);
            }
        }

        // complete with a tap, then undo from the toast
        await page.locator('#popButton').tap();
        await expect(topTask(page)).toHaveText('call the bank');
        await page.locator('#toastAction').tap();
        await expect(topTask(page)).toHaveText('pick up the parcel');

        // reorder with the buttons (drag and drop does not exist on touch)
        await page.locator('#taskStack .task-item', { hasText: 'call the bank' }).locator('.move-up-btn').tap();
        await expect(topTask(page)).toHaveText('call the bank');

        // the toast does not cover the Export / Import buttons
        await page.locator('#popButton').tap();
        const toast = await page.locator('#toast').boundingBox();
        const footer = await page.locator('#exportBtn').boundingBox();
        expect(toast.y + toast.height).toBeLessThanOrEqual(footer.y + 1);
    });
});
