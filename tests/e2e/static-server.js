'use strict';
// Minimal static file server for tests and local previews. Bound to 127.0.0.1 only.
// Usage: node tests/e2e/static-server.js [port]   (PORT env also works)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(req.url.split(/[?#]/)[0]);
    } catch (e) {
        res.writeHead(400).end('Bad request');
        return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(ROOT, '.' + pathname);
    const rel = path.relative(ROOT, file);
    // Only the app files; never node_modules, .git or tests
    if (rel.startsWith('..') || path.isAbsolute(rel) || /^(\.git|node_modules|tests)(\/|$)/.test(rel)) {
        res.writeHead(404).end('Not found');
        return;
    }
    fs.readFile(file, (err, body) => {
        if (err) {
            res.writeHead(404).end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(body);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/`);
});
