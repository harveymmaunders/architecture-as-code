import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderPage } from './page.mjs';

const HOSTILE = '<img src=x onerror=alert(1)>"\'&';
const hostileFlow = { slug: 'x"><script>', name: HOSTILE, description: HOSTILE, criticality: HOSTILE, steps: [] };

test('the page escapes flow names, descriptions, slugs and criticality', () => {
    const html = renderPage('customer-portal', [hostileFlow]);
    assert.doesNotMatch(html, /<img|<script>(?!\n)|x"><script>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
    const json = html.slice(html.indexOf('<script type="application/json"'), html.indexOf('</script>') + 9);
    assert.doesNotMatch(json.slice(json.indexOf('>') + 1, -9), /</);
});

// Runs the page script with a stub DOM and gives its render(card, result).
function pageRender() {
    const html = renderPage('customer-portal', []);
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const context = { document: { querySelectorAll: () => [] }, location: { search: '' }, URLSearchParams, CSS: { escape: String } };
    vm.runInNewContext(`${script}\nthis.render = render;`, context);
    return (result) => {
        const box = { innerHTML: '', classList: { add() {} } };
        context.render({ querySelector: () => box }, result);
        return box.innerHTML;
    };
}

test('the page script escapes every value of a flow result', () => {
    const render = pageRender();
    const html = render({
        ok: false,
        durationMs: HOSTILE,
        traceUrl: 'javascript:"><img>',
        steps: [{ status: 'failed', sequence: HOSTILE, from: HOSTILE, to: HOSTILE, description: HOSTILE, reason: HOSTILE, latencyMs: HOSTILE }],
    });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /Failed at step &lt;img/);
});

test('the page script shows a failed run that names no failed step', () => {
    const html = pageRender()({ ok: false, durationMs: 5, traceUrl: 'http://g', steps: [] });
    assert.match(html, /Failed at step \?/);
});
