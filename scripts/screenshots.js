'use strict';
// Dev-only: regenerates docs/screenshots/*.png from the real app in headless Chromium.
// Usage: npm run screenshots   (needs `npm install` and `npx playwright install chromium`)
// The app is served from 127.0.0.1 on a free port and seeded with neutral sample tasks.
// Web fonts are blocked so every run renders with the same system fallback font.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
const { createServer } = require('../tests/e2e/static-server.js');

const OUT = path.join(__dirname, '../docs/screenshots');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function seed() {
    const now = Date.now();
    const ago = ms => new Date(now - ms).toISOString();
    const task = (text, id, category, age) => ({ text, id, category, createdAt: ago(age) });
    return {
        tasks: [
            task('Submit the expense report', 'w1', 'Work', 6 * HOUR),
            task('Update the onboarding checklist', 'w2', 'Work', 5 * HOUR),
            task('Book a meeting room for Thursday', 'w3', 'Work', 4 * HOUR),
            task('Print the agenda', 'w4', 'Work', 3 * HOUR),
            task('Reply to Dana about the Q3 schedule', 'w5', 'Work', 2 * HOUR),
            task('Review pull request #128', 'w6', 'Work', 30 * MIN),
            task('Buy groceries', 'p1', 'Personal', 3 * HOUR),
            task('Call the dentist', 'p2', 'Personal', 1 * HOUR)
        ],
        completed: [
            { ...task('Send the invoice to the client', 'c1', 'Work', 8 * HOUR), completedAt: ago(20 * MIN) },
            { ...task('Back up the project folder', 'c2', 'Work', 9 * HOUR), completedAt: ago(2 * HOUR) },
            { ...task('Renew the parking permit', 'c3', 'Work', 30 * HOUR), completedAt: ago(26 * HOUR) }
        ],
        archived: [
            { ...task('Research standing desks', 'a1', 'Work', 50 * HOUR), archivedAt: ago(48 * HOUR) }
        ],
        categories: ['Work', 'Personal'],
        currentCategory: 'Work'
    };
}

async function open(browser, contextOptions, data) {
    const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: 'light', ...contextOptions });
    const page = await context.newPage();
    const problems = [];
    page.on('console', msg => { if (msg.type() === 'error') problems.push(msg.text()); });
    page.on('pageerror', err => problems.push(err.message));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.goto(contextOptions.baseURL);
    if (data) {
        await page.evaluate(raw => localStorage.setItem('fileDB', raw), JSON.stringify(data));
        await page.reload();
    }
    await page.waitForTimeout(500); // let the rows finish fading in
    return { context, page, problems };
}

// The hero task is 10 minutes into its tomato
function seedFocused() {
    const data = seed();
    const top = data.tasks.findIndex(t => t.id === 'w6');
    data.tasks[top] = { ...data.tasks[top], timerStartedAt: new Date(Date.now() - 10 * MIN).toISOString() };
    return data;
}

async function main() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}/`;
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    const written = [];
    let problems = [];

    try {
        const desktop = { baseURL, viewport: { width: 1280, height: 800 } };
        const phone = { baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
        const shot = async (page, name) => {
            const file = path.join(OUT, name);
            await page.screenshot({ path: file });
            written.push(file);
        };
        const scene = async (contextOptions, data, name, act) => {
            const s = await open(browser, contextOptions, data);
            if (act) await act(s.page);
            await shot(s.page, name);
            problems = problems.concat(s.problems);
            await s.context.close();
        };

        // 1. The empty plate: nothing saved yet
        await scene(desktop, null, 'empty.png');
        // 2. Waiting: a stack of tasks, the newest one is the one to do now
        await scene(desktop, seed(), 'stack.png');
        // 3. Focused: ten minutes into the tomato
        await scene(desktop, seedFocused(), 'focus.png');
        // 4. Just done: the next task slid in, the Undo toast is up, the Completed list is open
        await scene({ baseURL, viewport: { width: 1280, height: 1400 } }, seed(), 'completed.png', async page => {
            await page.locator('#popButton').click();
            await page.locator('.completed-section .section-toggle').click();
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.mouse.move(5, 5);
            await page.waitForTimeout(500);
        });
        // 5. Phone: waiting, focused, just done, empty
        await scene(phone, seed(), 'mobile.png');
        await scene(phone, seedFocused(), 'mobile-focus.png');
        await scene(phone, seed(), 'mobile-done.png', async page => {
            await page.locator('#popButton').tap();
            await page.waitForTimeout(500);
        });
        await scene(phone, null, 'mobile-empty.png');
    } finally {
        await browser.close();
        server.close();
    }

    written.forEach(file => console.log('wrote', path.relative(path.join(__dirname, '..'), file)));
    if (problems.length > 0) {
        console.error('Console errors while capturing:\n' + problems.join('\n'));
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
