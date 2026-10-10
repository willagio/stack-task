'use strict';
// Guards the text/background pairs used by style.css against dropping below WCAG AA (4.5:1).
// Colours are read from the :root custom properties, so editing the palette re-runs the check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../../style.css'), 'utf8');
const root = css.match(/:root\s*{([^}]*)}/)[1];
const variable = name => root.match(new RegExp(`--${name}:\\s*([^;]+);`))[1].trim();

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hexes = value => value.match(/#[0-9a-f]{6}/gi);
const channel = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const luminance = c => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

const text = rgb(variable('text-primary'));
const secondary = rgb(variable('text-secondary'));
const card = rgb(variable('bg-card'));
const input = rgb(variable('bg-input'));
const top = rgb(variable('bg-top'));

const pairs = [
    ['secondary text on the card', secondary, card],
    ['secondary text on inputs and task rows', secondary, input],
    ['secondary text on the top task', secondary, top],
    ['danger icons on the card', rgb(variable('danger')), card],
    ['focus colour on the card', rgb(variable('focus')), card],
    ...hexes(variable('primary-gradient')).map(h => [`white text on primary gradient ${h}`, text, rgb(h)]),
    ...hexes(variable('secondary-gradient')).map(h => [`white text on secondary gradient ${h}`, text, rgb(h)])
];

for (const [name, fg, bg] of pairs) {
    test(`contrast >= 4.5: ${name}`, () => {
        const value = ratio(fg, bg);
        assert.ok(value >= 4.5, `${name}: ${value.toFixed(2)}:1`);
    });
}
