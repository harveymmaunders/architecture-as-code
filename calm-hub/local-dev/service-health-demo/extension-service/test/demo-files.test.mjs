// Runs the rules on the demo architecture and flows, when the architecture task has made them.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { flowUrlsOf } from '../calm.mjs';
import { analyse } from '../analysis.mjs';
import { health } from './fixtures.mjs';

const dir = new URL('../../architecture/', import.meta.url);
const archFile = new URL('service-health.architecture.json', dir);
const skip = !existsSync(archFile) && 'the demo architecture is not there';

describe('demo architecture files', { skip }, () => {
    const arch = () => JSON.parse(readFileSync(archFile, 'utf8'));
    const flows = () => readdirSync(new URL('flows/', dir)).filter((f) => f.endsWith('.json'))
        .map((f) => ({ flow: JSON.parse(readFileSync(new URL(`flows/${f}`, dir), 'utf8')) }));

    it('names a flow URL for each flow file', () => {
        assert.equal(flowUrlsOf(arch()).length, flows().length);
    });

    it('every flow uses only relationships of the architecture', () => {
        for (const f of analyse({ architecture: arch(), health: health(), flows: flows() }).flows) {
            assert.ok(f.steps.every((s) => s.from && s.to), f.id);
            assert.equal(f.status, 'ok', f.id);
        }
    });

    it('central-db down breaks the flows that reach it, and orders-api down only some', () => {
        const count = (h) => analyse({ architecture: arch(), health: h, flows: flows() }).summary.flows.broken;
        const db = count(health({ failing: ['central-db'] }));
        const orders = count(health({ failing: ['orders-api'] }));
        assert.ok(db > orders && orders > 0, `central-db ${db}, orders-api ${orders}`);
    });
});
