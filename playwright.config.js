// Dev-only: end-to-end smoke test. The app itself has no build step or dependencies.
const { defineConfig, devices } = require('@playwright/test');

const PORT = 4173;

module.exports = defineConfig({
    testDir: 'tests/e2e',
    testMatch: '**/*.spec.js',
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        ...devices['Desktop Chrome'],
        acceptDownloads: true
    },
    webServer: {
        command: `node tests/e2e/static-server.js ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: false
    }
});
