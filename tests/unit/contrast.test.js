'use strict';
// Guards the text/background pairs used by style.css against dropping below WCAG AA (4.5:1 for text,
// 3:1 for graphics and focus rings). Colours are read from the :root custom properties, so editing the
// palette re-runs the check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../../style.css'), 'utf8');
const root = css.match(/:root\s*{([^}]*)}/)[1];
const variable = name => root.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))[1];

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const channel = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const luminance = c => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

const c = name => rgb(variable(name));

const textPairs = [
    ['ink on the page', 'ink', 'paper'],
    ['ink on the hero card', 'ink', 'card'],
    ['ink on waiting rows and inputs', 'ink', 'input-bg'],
    ['ink on the toast', 'ink', 'blush'],
    ['ink on the tally badge', 'ink', 'sun'],
    ['soft text on the page', 'soft', 'paper'],
    ['soft text on the hero card', 'soft', 'card'],
    ['soft text and placeholders on inputs and rows', 'soft', 'input-bg'],
    ['soft text on the toast', 'soft', 'blush'],
    ['clock digits on the tomato-deep face', 'on-fill', 'tomato-deep'],
    ['Add button text on tomato-deep', 'on-fill', 'tomato-deep'],
    ['Done text on leaf', 'on-fill', 'leaf'],
    ['Start text and the active tab on ink', 'on-fill', 'ink'],
    ['accent text on the page', 'tomato-deep', 'paper'],
    ['accent text on the hero card', 'tomato-deep', 'card'],
    ['accent text on the toast (Undo)', 'tomato-deep', 'blush'],
    ['danger text on the card', 'danger', 'card'],
    ['danger text on the page', 'danger', 'paper']
];

for (const [name, fg, bg] of textPairs) {
    test(`contrast >= 4.5: ${name}`, () => {
        const value = ratio(c(fg), c(bg));
        assert.ok(value >= 4.5, `${name}: ${value.toFixed(2)}:1`);
    });
}

// Graphics and keyboard focus need 3:1 against what they sit on
const graphicPairs = [
    ['the tomato wedge on the blush track', 'tomato', 'blush'],
    ['the tomato wedge on the page', 'tomato', 'paper'],
    ['the focus ring on the page', 'focus', 'paper'],
    ['the focus ring on the card', 'focus', 'card'],
    ['the input border on its fill', 'soft', 'input-bg']
];

for (const [name, fg, bg] of graphicPairs) {
    test(`contrast >= 3: ${name}`, () => {
        const value = ratio(c(fg), c(bg));
        assert.ok(value >= 3, `${name}: ${value.toFixed(2)}:1`);
    });
}

// The pairs the palette must never be used for (body text): they sit below AA on purpose
test('the bright tomato stays a graphic colour: it fails as a text or button-fill colour', () => {
    assert.ok(ratio(c('on-fill'), c('tomato')) < 4.5, 'white on #E0442B would need a darker red');
    assert.ok(ratio(c('tomato-deep'), c('sun')) < 4.5);
});

test('the palette has no dark-theme leftovers', () => {
    assert.doesNotMatch(css, /color-scheme:\s*dark/);
    assert.doesNotMatch(css, /rgba\(50,\s*209,\s*106/, 'no phosphor-green glow colours');
});
