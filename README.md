# Stack Task Organizer

A small task manager that keeps your tasks in a stack, so you work on one thing at a time. It runs in the browser with plain HTML, CSS and JavaScript: no build step, no dependencies.

![Task stack with the top task highlighted](docs/screenshots/stack.png)

## How it works

- **Stack:** a new task goes on top. The top task is highlighted and is the one to work on; the rest are numbered below it.
- **Complete:** "Complete top task" moves the top task to the Completed list. Tasks can also be archived, deleted, or moved up and down with the buttons on each row (or dragged with the mouse).
- **Categories:** each category (`Work` and `Personal` to start with) has its own stack, shown as tabs. Add, rename and delete them with the buttons next to the tabs, or double-click a tab to rename it. Drag tabs, or press `Alt` + arrow keys, to reorder them.
- **Archive and Completed:** collapsible lists per category. Restore a task to the bottom of its stack, or delete it for good.
- **Undo:** completing, archiving, deleting and importing show an Undo toast for a few seconds (also `Ctrl`/`Cmd` + `Z`). Only the latest action can be undone.
- **Keyboard and touch:** everything is reachable by keyboard (arrow keys switch tabs), and the layout adapts to phone-sized screens.

| Completed list with Undo | Phone |
| --- | --- |
| ![Completed list expanded, with an Undo toast](docs/screenshots/completed.png) | ![The app on a phone-sized screen](docs/screenshots/mobile.png) |

An empty start screen is in [docs/screenshots/empty.png](docs/screenshots/empty.png).

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
npm run serve        # http://127.0.0.1:4173/  (uses node, nothing to install)
```

The Inter font is loaded from Google Fonts when available; without it the system font is used.

## Your data

Everything stays in your browser. There is no server and no account.

- Tasks are stored as JSON in `localStorage` under the key `fileDB`: `{ tasks, completed, archived, categories, currentCategory, schemaVersion }`.
- **Export** downloads that data as `tasks-backup-YYYY-MM-DD.json`. **Import** checks the file first, asks before replacing your current data, and can be undone. Files over 5 MB or with invalid tasks are rejected without changing anything.
- Data from earlier versions loads as is. If only the older separate keys (`taskStack`, `completedTasks`, `archivedTasks`, `categories`, `currentCategory`) exist, they are migrated into `fileDB`.
- If the stored `fileDB` cannot be parsed, the raw text is kept under `fileDB.backup-<timestamp>` and you are told about it.
- Clearing site data deletes your tasks. Export a backup if they matter.

## Development

```sh
npm test                 # unit tests, Node's built-in test runner, no install needed
npm install              # once, for the browser tests and screenshots
npx playwright install chromium
npm run test:e2e         # smoke tests in headless Chromium, desktop and phone viewport
npm run screenshots      # regenerates docs/screenshots/*.png
```

Source layout: `state.js` (task and category logic), `storage.js` (`localStorage`, import and export), `ui.js` (toast, live region, dialog), `render.js` (DOM), `dnd.js` (drag and drop), `app.js` (event wiring). They are classic scripts loaded in that order by `index.html`, so the page also works from `file://`.

## License

MIT, see [LICENSE](LICENSE).
