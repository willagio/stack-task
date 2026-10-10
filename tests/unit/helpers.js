'use strict';

// Minimal localStorage stand-in. `failSet` simulates quota errors.
function createLocalStorageStub(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        failSet: false,
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) {
            if (this.failSet) throw new Error('QuotaExceededError');
            map.set(key, String(value));
        },
        removeItem(key) { map.delete(key); },
        keys() { return [...map.keys()]; }
    };
}

const XSS = '<img src=x onerror=alert(1)>';

module.exports = { createLocalStorageStub, XSS };
