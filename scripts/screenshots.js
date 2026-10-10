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
            task('Draft release notes for v2.4', 'w4', 'Work', 3 * HOUR),
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
    const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: 'dark', ...contextOptions });
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
    return { context, page, problems };
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
        const desktop = { baseURL, viewport: { width: 640, height: 860 } };
        const shot = async (page, name) => {
            const file = path.join(OUT, name);
            await page.screenshot({ path: file });
            written.push(file);
        };

        // 1. Default screen: nothing saved yet
        let s = await open(browser, desktop, null);
        await shot(s.page, 'empty.png');
        problems = problems.concat(s.problems);
        await s.context.close();

        // 2. Several stacked tasks; the newest one is the focus. Hover shows the row actions.
        s = await open(browser, desktop, seed());
        await s.page.locator('#taskStack .task-item').nth(2).hover();
        await s.page.waitForTimeout(400); // let the hover transition finish
        await shot(s.page, 'stack.png');
        problems = problems.concat(s.problems);
        await s.context.close();

        // 3. Completed list expanded, with the Undo toast from completing a task
        s = await open(browser, { baseURL, viewport: { width: 640, height: 1000 } }, seed());
        await s.page.locator('#popButton').click();
        await s.page.locator('.completed-section .section-toggle').click();
        await s.page.mouse.move(5, 5);
        await s.page.waitForTimeout(400); // let the toast finish animating in
        await shot(s.page, 'completed.png');
        problems = problems.concat(s.problems);
        await s.context.close();

        // 4. Phone-sized touch viewport
        s = await open(browser, {
            baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true
        }, seed());
        await shot(s.page, 'mobile.png');
        problems = problems.concat(s.problems);
        await s.context.close();
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
