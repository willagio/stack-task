// Browser smoke test. Run with `npm run test:e2e` (needs `npm install` and
// `npx playwright install chromium`). Every test fails on any console error or uncaught page error.
const { test, expect } = require('@playwright/test');
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
    await page.locator('.completed-section .section-header').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['third']);

    // delete the top task (confirm dialog)
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#taskStack .top-task .remove-btn').click({ force: true });
    await expect(topTask(page)).toHaveText('first');

    // cancelling a delete asks only once
    let dialogs = 0;
    page.on('dialog', dialog => { dialogs++; dialog.dismiss(); });
    await page.locator('#taskStack .top-task .remove-btn').click({ force: true });
    expect(dialogs).toBe(1);
    page.removeAllListeners('dialog');

    await page.reload();
    await expect(topTask(page)).toHaveText('first');
    await page.locator('.completed-section .section-header').click();
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
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#importFile').setInputFiles(file);
    await expect(topTask(page)).toHaveText('keep me');
    await page.locator('.completed-section .section-header').click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['done me']);

    await page.reload();
    await expect(topTask(page)).toHaveText('keep me');
});

test('invalid import is rejected and leaves data untouched', async ({ page }, testInfo) => {
    await page.goto('/');
    await addTask(page, 'precious');
    const bad = testInfo.outputPath('bad.json');
    fs.writeFileSync(bad, JSON.stringify({ tasks: [{ text: '<img src=x onerror=alert(1)>', id: '"><img src=x>' }] }));

    const messages = [];
    page.on('dialog', dialog => { messages.push(dialog.message()); dialog.accept(); });
    await page.locator('#importFile').setInputFiles(bad);
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatch(/Import failed/);
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
    await page.locator('.completed-section .section-header').click();
    await page.locator('.tab', { hasText: 'Personal' }).click();
    await expect(page.locator('#completedTasks .completed-text')).toHaveText(['Done thing']);
    // numeric ids survive a round trip through the new storage module
    await addTask(page, 'new one');
    const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('fileDB')).tasks.map(t => t.id));
    expect(ids.slice(0, 3)).toEqual([1700000000001, 1700000000002, 1700000000003]);
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
