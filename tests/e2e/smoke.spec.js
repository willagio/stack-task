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

// The hero shows the top task; everything else waits in #taskStack
const topTask = page => page.locator('#heroText');
const shownTasks = page => page.locator('#heroText, #taskStack .task-text');

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
    await page.locator('#heroTask').hover();
    await page.locator('#heroTask .remove-btn').click();
    await expect(topTask(page)).toHaveText('first');
    await expect(page.locator('#toast')).toContainText('Deleted "second"');
    await page.locator('#toastAction').click();
    await expect(topTask(page)).toHaveText('second');
    await page.locator('#heroTask').hover();
    await page.locator('#heroTask .remove-btn').click();
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
    await expect(page.locator('#hero img, #taskStack img')).toHaveCount(0);
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
    await page.locator('#toastClose').click(); // a warning stays until dismissed, and it sits over the category tabs
    await expect(page.locator('.tab .tab-name')).toHaveText(['Work', 'Personal', longCategory]);
    await expect(topTask(page)).toHaveText(longText);
    await expect(page.locator('#taskStack .task-text')).toHaveText(['Write report']);
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
    // "first" is the hero now: focus follows it there, onto its Start button
    await expect(page.locator('#timerButton')).toBeFocused();

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
    // c is in the hero; a and b wait below it. Drag a above b (the upper half of b's row)
    const item = text => page.locator('#taskStack .task-item', { hasText: new RegExp('^' + text + '(?![a-z])') });
    await item('a').dragTo(item('b'), { targetPosition: { x: 100, y: 5 } });
    await expect(topTask(page)).toHaveText('c');
    await expect(page.locator('#taskStack .task-text')).toHaveText(['a', 'b']);
    // and to the top with the button: a becomes the hero
    await item('a').locator('.move-up-btn').click();
    await expect(topTask(page)).toHaveText('a');
    await expect(shownTasks(page)).toHaveText(['a', 'c', 'b']);

    await page.locator('.tab', { hasText: 'Personal' }).dragTo(page.locator('.tab', { hasText: 'Work' }), { targetPosition: { x: 5, y: 10 } });
    await expect(page.locator('.tab-name')).toHaveText(['Personal', 'Work']);
    await page.reload();
    await expect(page.locator('.tab-name')).toHaveText(['Personal', 'Work']);
    await page.locator('.tab', { hasText: 'Work' }).click();
    await expect(shownTasks(page)).toHaveText(['a', 'c', 'b']);
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

        // the hero carries Start and Done; lower rows fold their buttons away until the row is tapped
        await expect(page.locator('#heroTask .now-actions')).toBeVisible();
        const lower = page.locator('#taskStack .task-item');
        expect((await lower.locator('.task-actions').boundingBox()).height).toBeLessThanOrEqual(1);
        await lower.locator('.task-text').tap();
        await expect(lower).toHaveClass(/open/);

        // every control is at least 44px
        const selectors = ['#addTaskBtn', '#popButton', '#timerButton', '#taskInput', '#addCategoryBtn', '#renameCategoryBtn',
            '#deleteCategoryBtn', '.tab-button', '.section-toggle', '#exportBtn', '#importBtn',
            '#taskStack .task-item .task-action-btn', '#thenLink'];
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

        // the toast sits at the top and does not cover the tools at the bottom
        await page.locator('#popButton').tap();
        const toast = await page.locator('#toast').boundingBox();
        const footer = await page.locator('#exportBtn').boundingBox();
        expect(toast.y + toast.height).toBeLessThanOrEqual(footer.y + 1);
    });
});

test.describe('phone: folded row buttons and the Done button in the hero', () => {
    const { defaultBrowserType, ...phone } = devices['Pixel 7'];
    test.use(phone);

    test('a folded button unfolds on focus, and tapping Done completes the task', async ({ page }) => {
        await page.goto('/');
        await addTask(page, 'a');
        await addTask(page, 'b');
        await addTask(page, 'c');
        // row numbers and paused-timer buttons are gone from the lower rows
        await expect(page.locator('.task-index')).toHaveCount(0);
        await expect(page.locator('#taskStack .task-item .timer-btn')).toHaveCount(0);

        // keyboard focus on a folded button opens it at full size with a solid outline
        const up = page.locator('#taskStack .task-item .move-up-btn').first();
        await up.focus();
        const box = await up.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(43.5);
        expect(box.height).toBeGreaterThanOrEqual(43.5);
        expect(await up.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
        await page.locator('#taskInput').focus();

        // tapping Done in the hero completes the top task (no layout shift swallows the tap)
        await page.locator('#popButton').tap();
        await expect(topTask(page)).toHaveText('b');
        // Start the timer from the hero: the clock shows time left and the status changes
        await page.locator('#timerButton').tap();
        await expect(page.locator('#heroStatus')).toHaveText('Ripening…');
        await expect(page.locator('#heroClock')).toHaveText(/^(24:5\d|25:00)$/);
    });
});

test('keyboard only: Done in the hero completes, and focus stays on the Done button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#taskInput')).toBeFocused(); // desktop starts in the input
    await addTask(page, 'first');
    await addTask(page, 'second');
    await page.locator('#popButton').focus();
    await page.keyboard.press('Enter');
    await expect(topTask(page)).toHaveText('first');
    await expect(page.locator('#popButton')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#taskInput')).toBeFocused();
    await expect(page.locator('#popButton')).toBeDisabled();
    await expect(page.locator('#popButton')).toBeHidden();
});

test.describe('desktop mouse: Done clicked while a task name is being edited', () => {
    // The edit field saves on blur at mousedown; the click on Done must still complete the top task
    for (const [label, row, expected] of [
        ['the top task', 'c', { stack: ['a', 'b'], completed: ['renamed'] }],
        ['a lower row', 'b', { stack: ['a', 'renamed'], completed: ['c'] }]
    ]) {
        test(`editing ${label}, then clicking Done saves the name and completes the top task`, async ({ page }) => {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto('/');
            for (const text of ['a', 'b', 'c']) await addTask(page, text);
            await page.locator('#heroText, #taskStack .task-text', { hasText: new RegExp(`^${row}$`) }).dblclick();
            await page.locator('.task-edit').fill('renamed');
            const box = await page.locator('#popButton').boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await expect(shownTasks(page)).toHaveText([...expected.stack].reverse());
            await expect(page.locator('.task-edit')).toHaveCount(0);
            const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')));
            expect(stored.tasks.map(t => t.text)).toEqual(expected.stack);
            expect(stored.completed.map(t => t.text)).toEqual(expected.completed);
            await expect(page.locator('#toast')).toContainText(`Done "${expected.completed[0]}"`);
        });
    }
});

test('a change from another tab keeps the hero card, and focus on Done, in place', async ({ page, context }) => {
    await page.goto('/');
    for (const text of ['a', 'b']) await addTask(page, text);
    await page.evaluate(() => { window.__topCard = document.querySelector('#heroTask'); });
    await page.locator('#popButton').focus();
    const other = await context.newPage();
    await other.goto('/');
    await other.locator('#taskStack .task-text', { hasText: /^a$/ }).dblclick();
    await other.locator('.task-edit').fill('a from the other tab');
    await other.locator('.task-edit').press('Enter');
    await expect(shownTasks(page)).toHaveText(['b', 'a from the other tab']);
    await expect(page.locator('#popButton')).toBeFocused();
    expect(await page.evaluate(() => document.querySelector('#heroTask') === window.__topCard)).toBe(true);
    await other.close();
});

// ---- One Tomato ---------------------------------------------------------------------------------

const MIN = 60 * 1000;
const seedTasks = names => JSON.stringify({
    tasks: names.map((text, i) => ({ text, id: 'seed' + i, category: 'Work', createdAt: '2026-10-10T08:00:00.000Z' })),
    completed: [], archived: [], categories: ['Work', 'Personal'], currentCategory: 'Work'
});

async function seed(page, raw) {
    await page.goto('/');
    await page.evaluate(value => { localStorage.clear(); localStorage.setItem('fileDB', value); }, raw);
    await page.reload();
}

test.describe('the hero fits the first screen, with no sideways scroll', () => {
    const sizes = [['desktop', 1280, 800], ['phone', 390, 844], ['small phone', 390, 667]];
    for (const [label, width, height] of sizes) {
        test(`${label} ${width}x${height}`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await seed(page, seedTasks(['Submit the expense report', 'Reply to Dana about the Q3 schedule', 'Review pull request #128']));
            const fits = async selector => {
                const box = await page.locator(selector).boundingBox();
                expect(box, selector).not.toBeNull();
                expect(box.y, selector + ' top').toBeGreaterThanOrEqual(0);
                expect(box.y + box.height, selector + ' bottom').toBeLessThanOrEqual(height);
                expect(box.x, selector + ' left').toBeGreaterThanOrEqual(0);
                expect(box.x + box.width, selector + ' right').toBeLessThanOrEqual(width);
            };
            for (const selector of ['#heroText', '#dial', '#heroClock', '#timerButton', '#popButton']) await fits(selector);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    }
});

test('start, ripen, one more, done, next: the 25-minute flow', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-10T09:00:00Z') });
    await seed(page, seedTasks(['write the report', 'call the bank']));
    await expect(topTask(page)).toHaveText('call the bank');
    await expect(page.locator('#heroClock')).toHaveText('25:00');
    await expect(page.locator('#heroStatus')).toHaveText('Fresh tomato. Start?');
    await expect(page.locator('#thenLink')).toHaveText('Then: write the report');

    await page.locator('#timerButton').click();
    await page.clock.runFor(10 * MIN);
    await expect(page.locator('#heroClock')).toHaveText('15:00');
    await expect(page.locator('#heroStatus')).toHaveText('Ripening…');
    await expect(page).toHaveTitle('15:00 · call the bank');
    // the wedge really shrinks: 15 of 25 minutes left is 60% of the circle (the stylesheet must not override it)
    const wedge = await page.locator('#dialArc').evaluate(el => parseFloat(getComputedStyle(el).strokeDasharray));
    expect(wedge / 138.23).toBeCloseTo(0.6, 2);
    await page.clock.runFor(10 * MIN + 30 * 1000);
    await expect(page.locator('#heroStatus')).toHaveText('Almost ripe.');
    await expect(page.locator('#dial')).toHaveClass(/tilt/);

    await page.clock.runFor(5 * MIN);
    await expect(page.locator('#heroStatus')).toHaveText('Ripe! Take five, then Done — or one more?');
    await expect(page.locator('#timerButton')).toContainText('One more');
    await expect(page.locator('#heroClock')).toHaveText('00:00');
    await expect(page).toHaveTitle('Ripe! · call the bank');
    await expect(page.locator('#liveRegion')).toContainText('Ripe! "call the bank" — 25 minutes done.');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).tasks.find(t => t.id === 'seed1'));
    expect(stored.timeSpent).toBe(25 * MIN);
    expect(stored.timerStartedAt).toBeUndefined();
    await expect(page.locator('#heroTally svg')).toHaveCount(1);
    // ripe never completes the task by itself
    await expect(topTask(page)).toHaveText('call the bank');

    await page.locator('#timerButton').click();      // one more
    await expect(page.locator('#heroStatus')).toHaveText('Ripening…');
    await expect(page).toHaveTitle('25:00 · call the bank');
    await page.clock.runFor(2 * MIN);
    await page.locator('#timerButton').click();      // pause
    await expect(page.locator('#heroClock')).toHaveText('23:00');

    await page.locator('#popButton').click();       // Done
    await expect(page.locator('#toast')).toContainText('Done "call the bank" in 27m. Next tomato!');
    await expect(topTask(page)).toHaveText('write the report');
    await expect(page.locator('#heroClock')).toHaveText('25:00');
    await expect(page.locator('#heroTask')).toHaveClass(/became-top/);
    await expect(page.locator('#thenNone')).toBeVisible();
    await expect(page.locator('#thenNone')).toHaveText('Last one on the plate.');
    await expect(page.locator('#thenLink')).toBeHidden();
});

// Background tabs throttle setInterval (Chrome: about once a minute) and phones freeze it, so the first tick
// after 25:00 can come much later. An open page's tomato still ripened at 25:00.
const T_START = Date.parse('2026-10-10T09:00:00Z');
const RIPE_TEXT = 'Ripe! Take five, then Done — or one more?';

async function startNearBoundary(page, text) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install({ time: new Date(T_START) });
    await page.goto('/');
    await addTask(page, text);
    await page.locator('#timerButton').click();
    await page.clock.runFor(24 * MIN + 59 * 1000);
    await expect(page.locator('#heroClock')).toHaveText('00:01');
}

// Moves the clock with no tick at all (pauseAt would fire the overdue tick once): a frozen tab
async function jumpWithoutTick(page, to) {
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 100));
    await page.clock.setSystemTime(new Date(to));
}

const storedTop = page => page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).tasks.at(-1));

async function expectRipe(page, text) {
    await expect(page.locator('#heroClock')).toHaveText('00:00');
    await expect(page.locator('#heroStatus')).toHaveText(RIPE_TEXT);
    await expect(page.locator('#timerButton')).toContainText('One more');
    await expect(page).toHaveTitle(`Ripe! · ${text}`);
    const stored = await storedTop(page);
    expect(stored.timeSpent).toBe(25 * MIN);
    expect(stored.timerStartedAt).toBeUndefined();
}

for (const [label, late] of [['40 seconds', 40 * 1000], ['10 minutes', 10 * MIN]]) {
    test(`a tick ${label} late still ripens the tomato at exactly 25:00, with a visible toast`, async ({ page }) => {
        await startNearBoundary(page, 'late tick');
        await page.clock.pauseAt(new Date(T_START + 25 * MIN + late));    // no tick fired in between
        await page.clock.runFor(1000);                                     // the late tick
        await expectRipe(page, 'late tick');
        await expect(page.locator('#toast')).toBeVisible();
        await expect(page.locator('#toastMessage')).toHaveText('Ripe! "late tick" — 25 minutes done. The timer stopped at 25:00.');
        await expect(page.locator('#liveRegion')).toContainText('Ripe! "late tick" — 25 minutes done.');
        // One more is a fresh 25 minutes
        await page.locator('#timerButton').click();
        await expect(page.locator('#heroClock')).toHaveText('25:00');
        await expect(page).toHaveTitle('25:00 · late tick');
    });
}

test('coming back to a frozen tab ripens the tomato at once, at 25:00', async ({ page }) => {
    await startNearBoundary(page, 'frozen tab');
    await jumpWithoutTick(page, T_START + 35 * MIN);                     // frozen: no tick for 10 minutes
    await expect(page.locator('#heroStatus')).toHaveText('Almost ripe.');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expectRipe(page, 'frozen tab');
    await expect(page.locator('#toastMessage')).toHaveText('Ripe! "frozen tab" — 25 minutes done. The timer stopped at 25:00.');
});

test('a tomato that ripens while the tab is hidden changes the title, and is toasted when the user is back', async ({ page }) => {
    await startNearBoundary(page, 'other tab');
    await page.evaluate(() => {
        window.__hidden = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(2000);
    await expect(page).toHaveTitle('Ripe! · other tab');
    await expect(page.locator('#toast')).toBeHidden();
    expect((await storedTop(page)).timeSpent).toBe(25 * MIN);
    await page.clock.runFor(60 * 1000);                                    // longer than a toast would last
    await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('#toastMessage')).toHaveText('Ripe! "other tab" — 25 minutes done.');
    await expectRipe(page, 'other tab');
});

test('Pause or Done pressed after the boundary, before the late tick, records 25 minutes', async ({ page }) => {
    await startNearBoundary(page, 'pause me');
    await jumpWithoutTick(page, T_START + 25 * MIN + 40 * 1000);
    await expect(page.locator('#timerButton')).toContainText('Pause');
    await page.locator('#timerButton').click();                            // Pause, ahead of the tick
    await expectRipe(page, 'pause me');
    await expect(page.locator('#toastMessage')).toHaveText('Ripe! "pause me" — 25 minutes done. The timer stopped at 25:00.');

    await page.locator('#timerButton').click();                            // One more
    await page.clock.runFor(24 * MIN + 59 * 1000);
    await expect(page.locator('#heroClock')).toHaveText('00:01');
    await jumpWithoutTick(page, T_START + 25 * MIN + 40 * 1000 + 35 * MIN);   // 10 minutes past the second boundary
    await page.locator('#popButton').click();                              // Done, ahead of the tick
    await expect(page.locator('#toastMessage')).toContainText('Done "pause me" in 50m.');
    const done = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).completed[0]);
    expect(done.timeSpent).toBe(50 * MIN);
    expect(done.timerStartedAt).toBeUndefined();
    await expect(page).toHaveTitle('One Tomato');
});

test('the next task sliding in never widens a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    for (const text of ['one', 'two', 'three']) await addTask(page, text);
    // Done and add each start the 320 ms entrance; sample the page width through it
    for (const action of ['done', 'add']) {
        const widest = await page.evaluate(action => new Promise(resolve => {
            if (action === 'done') document.getElementById('popButton').click();
            else {
                const input = document.getElementById('taskInput');
                input.value = 'four';
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }
            const start = performance.now();
            let max = 0;
            (function sample() {
                max = Math.max(max, document.documentElement.scrollWidth);
                if (performance.now() - start < 450) requestAnimationFrame(sample); else resolve(max);
            })();
        }), action);
        expect(widest, action).toBeLessThanOrEqual(390);
    }
    await expect(page.locator('#heroTask')).toHaveClass(/became-top/);
});

test('keyboard only: add, Start, Done and the next task, without the mouse', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.type('one thing');
    await page.keyboard.press('Enter');
    await page.keyboard.type('another thing');
    await page.keyboard.press('Enter');
    await expect(topTask(page)).toHaveText('another thing');
    await page.locator('#timerButton').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#heroStatus')).toHaveText('Ripening…');
    await expect(page.locator('#timerButton')).toBeFocused();
    await page.keyboard.press('Space');                 // pause again
    await expect(page.locator('#heroStatus')).toHaveText('Half-ripe. Keep going?');
    await page.keyboard.press('Tab');                   // Start -> Done
    await expect(page.locator('#popButton')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(topTask(page)).toHaveText('one thing');
    await expect(page.locator('#popButton')).toBeFocused();
    // F2 renames the hero from its own text
    await topTask(page).focus();
    await page.keyboard.press('F2');
    await expect(page.locator('.task-edit')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' (renamed)');
    await page.keyboard.press('Enter');
    await expect(topTask(page)).toHaveText('one thing (renamed)');
    await expect(topTask(page)).toBeFocused();
});

test('adding a task puts it on top and pauses the timer of the one it buried', async ({ page }) => {
    await page.goto('/');
    await addTask(page, 'first');
    await page.locator('#timerButton').click();
    await expect(page.locator('#heroStatus')).toHaveText('Ripening…');
    await addTask(page, 'urgent');
    await expect(topTask(page)).toHaveText('urgent');
    await expect(page.locator('#heroStatus')).toHaveText('Fresh tomato. Start?');
    await expect(page.locator('#liveRegion')).toContainText('Paused "first" — new thing on top.');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).tasks);
    expect(stored.filter(t => t.timerStartedAt).length).toBe(0);
    await expect(page).toHaveTitle('One Tomato');
});

test('the Then line jumps to the waiting list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 667 });
    await seed(page, seedTasks(Array.from({ length: 8 }, (_, i) => 'task ' + i)));
    await page.locator('#thenLink').click();
    await expect(page.locator('#stackRest')).toBeInViewport();
});

test('original v0 data: every task is shown, and an action keeps every old field', async ({ page }) => {
    const v0 = JSON.parse(fs.readFileSync('tests/fixtures/original-v0.json', 'utf8'));
    await page.goto('/');
    await page.evaluate(raw => { localStorage.clear(); localStorage.setItem('fileDB', raw); }, v0.fileDB);
    await page.reload();
    await expect(shownTasks(page)).toHaveText(['Email "Bob" & <team>', 'Write report']);   // Work: hero + the one waiting
    await page.locator('.tab', { hasText: 'Personal' }).click();
    await expect(shownTasks(page)).toHaveText(['Buy milk']);
    await page.locator('.completed-section .section-toggle').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['Done thing']);
    await page.locator('.tab', { hasText: 'Work' }).click();
    await page.locator('.archive-section .section-toggle').click();
    await expect(page.locator('#archivedTasks .archived-text')).toHaveText(['Maybe later']);
    // start and pause: a save happens; every field of the old data is still there
    await page.locator('#timerButton').click();
    await page.locator('#timerButton').click();
    await addTask(page, 'new one');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')));
    v0.expected.tasks.forEach((old, i) => {
        const now = stored.tasks[i];
        for (const key of Object.keys(old)) expect(now[key], `task ${old.id} keeps ${key}`).toEqual(old[key]);
    });
    expect(stored.completed).toEqual(v0.expected.completed);
    expect(stored.archived).toEqual(v0.expected.archived);
    expect(stored.categories).toEqual(v0.expected.categories);
});

test('time already logged by the old count-up timer becomes tomatoes and time left', async ({ page }) => {
    const raw = JSON.stringify({
        tasks: [{ text: 'old timer', id: 'o1', category: 'Work', createdAt: '2026-10-01T09:00:00.000Z', timeSpent: 37 * MIN }],
        completed: [], archived: [], categories: ['Work', 'Personal'], currentCategory: 'Work'
    });
    await seed(page, raw);
    await expect(page.locator('#heroClock')).toHaveText('13:00');
    await expect(page.locator('#heroStatus')).toHaveText('Half-ripe. Keep going?');
    await expect(page.locator('#heroTally svg')).toHaveCount(1);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).tasks[0].timeSpent);
    expect(stored).toBe(37 * MIN);
});

test('reduced motion: the next task appears with no entrance animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await addTask(page, 'one');
    await addTask(page, 'two');
    await page.locator('#popButton').click();
    await expect(topTask(page)).toHaveText('one');
    await expect(page.locator('#heroTask')).not.toHaveClass(/became-top/);
    const motion = await page.evaluate(() => ({
        animation: getComputedStyle(document.querySelector('#heroTask')).animationName,
        dial: parseFloat(getComputedStyle(document.querySelector('#dial')).transitionDuration)
    }));
    expect(motion.animation).toBe('none');
    expect(motion.dial).toBeLessThan(0.001);
});
