'use strict';
// Tiny DOM stand-in for exercising render.js / dnd.js / app.js without a browser.
// Supports just what the app uses. Setting innerHTML throws, proving it is never used.

class FakeClassList {
    constructor(owner) { this.owner = owner; }
    get set() { return new Set(this.owner._className.split(/\s+/).filter(Boolean)); }
    _write(set) { this.owner._className = [...set].join(' '); }
    add(...names) { const s = this.set; names.forEach(n => s.add(n)); this._write(s); }
    remove(...names) { const s = this.set; names.forEach(n => s.delete(n)); this._write(s); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : force;
        if (on) this.add(name); else this.remove(name);
        return on;
    }
}

class FakeText {
    constructor(text) { this.nodeType = 3; this.data = text; this.parentNode = null; }
    get textContent() { return this.data; }
}

class FakeElement {
    constructor(tag, doc) {
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this.ownerDocument = doc;
        this.childNodes = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.dataset = {};
        this.style = {};
        this._className = '';
        this.classList = new FakeClassList(this);
        this.listeners = {};
        this.value = '';
        this.disabled = false;
        this.files = [];
        this.hidden = false;
    }
    get className() { return this._className; }
    set className(v) { this._className = String(v); }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
    set textContent(v) { this.replaceChildren(new FakeText(String(v))); }
    set innerHTML(_) { throw new Error('innerHTML must not be used'); }
    get innerHTML() { throw new Error('innerHTML must not be used'); }
    get id() { return this.attributes.get('id') || ''; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this; this.childNodes.push(node); return node;
    }
    removeChild(node) {
        this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node;
    }
    replaceChildren(...nodes) {
        this.childNodes.forEach(n => { n.parentNode = null; });
        this.childNodes = [];
        nodes.forEach(n => this.appendChild(n));
    }
    contains(node) {
        for (let n = node; n; n = n.parentNode) if (n === this) return true;
        return false;
    }
    matches(selector) {
        return selector.split(',').some(sel => {
            const m = sel.trim().match(/^([a-z0-9]*)((?:\.[\w-]+)*)(?:#([\w-]+))?$/i);
            if (!m) throw new Error('unsupported selector ' + sel);
            const [, tag, classes, id] = m;
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            if (id && this.id !== id) return false;
            return classes.split('.').filter(Boolean).every(c => this.classList.contains(c));
        });
    }
    closest(selector) {
        for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n;
        return null;
    }
    querySelectorAll(selector) {
        const parts = selector.trim().split(/\s+/);
        const out = [];
        const walk = (node) => node.children.forEach(child => {
            if (child.matches(parts[parts.length - 1])) {
                let ok = true, anc = child.parentNode;
                for (let i = parts.length - 2; i >= 0 && ok; i--) {
                    while (anc && anc.nodeType === 1 && !anc.matches(parts[i])) anc = anc.parentNode;
                    ok = !!(anc && anc.nodeType === 1);
                    if (ok) anc = anc.parentNode;
                }
                if (ok) out.push(child);
            }
            walk(child);
        });
        walk(this);
        return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 40 }; }
    click() { this.dispatch('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    select() {}
    // Bubbling dispatch. `props` become event fields.
    dispatch(type, props) {
        const event = { type, target: this, bubbles: true, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, ...props };
        for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
            event.currentTarget = n;
            (n.listeners[type] || []).slice().forEach(fn => fn(event));
        }
        return event;
    }
    listenerCount(type) { return (this.listeners[type] || []).length; }
}

class FakeDocument {
    constructor() {
        this.readyState = 'complete';
        this.activeElement = null;
        this.listeners = {};
        this.body = new FakeElement('body', this);
    }
    createElement(tag) { return new FakeElement(tag, this); }
    createElementNS(_ns, tag) { return new FakeElement(tag, this); }
    createTextNode(text) { return new FakeText(text); }
    getElementById(id) {
        const find = node => {
            for (const child of node.children) {
                if (child.id === id) return child;
                const hit = find(child);
                if (hit) return hit;
            }
            return null;
        };
        return find(this.body);
    }
    querySelector(sel) { return this.body.querySelector(sel); }
    querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    dispatch(type, props) {
        const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
        (this.listeners[type] || []).forEach(fn => fn(event));
        return event;
    }
}

// Builds the static page skeleton the app expects (ids/classes from index.html).
function buildPage(doc) {
    const add = (parent, tag, attrs = {}, cls = '') => {
        const el = doc.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        el.className = cls;
        parent.appendChild(el);
        return el;
    };
    const body = doc.body;
    const count = add(body, 'span', {}, 'stack-count');
    add(body, 'span', {}, 'stack-label');
    add(body, 'div', { id: 'tabsList' }, 'tabs-list');
    add(body, 'button', { id: 'addCategoryBtn' });
    add(body, 'button', { id: 'renameCategoryBtn' });
    add(body, 'button', { id: 'deleteCategoryBtn' });
    add(body, 'input', { id: 'taskInput' });
    add(body, 'button', { id: 'addTaskBtn' });
    add(body, 'button', { id: 'popButton' });
    const panel = add(body, 'div', { id: 'taskPanel' });
    add(panel, 'div', { id: 'taskStack' });
    const section = (cls, countId, listId) => {
        const el = add(body, 'div', {}, cls + ' collapsible-section collapsed');
        const toggle = add(add(el, 'div', {}, 'section-header'), 'button', { 'aria-expanded': 'false' }, 'section-toggle');
        add(toggle, 'span', { id: countId }, 'section-count');
        add(el, 'div', { id: listId });
    };
    section('archive-section', 'archivedCount', 'archivedTasks');
    section('completed-section', 'completedCount', 'completedTasks');
    add(body, 'button', { id: 'exportBtn' });
    add(body, 'button', { id: 'importBtn' });
    add(body, 'input', { id: 'importFile' });
    add(body, 'div', { id: 'liveRegion' });
    const toast = add(body, 'div', { id: 'toast' });
    toast.hidden = true;
    add(toast, 'span', { id: 'toastMessage' });
    add(toast, 'button', { id: 'toastAction' });
    add(toast, 'button', { id: 'toastClose' });
    return count;
}

module.exports = { FakeDocument, FakeElement, buildPage };
