// Checks the manifest and every blocks reply against the CALM Hub extension schemas.
// ajv comes from the monorepo root node_modules; the service itself has no dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { DECORATOR_VIEW } from '../decorators.mjs';
import { cardReply, flowStatusReply, namespacesScreen, traceLinksScreen } from '../screen-view.mjs';
import { simulationReply } from '../simulation.mjs';
import { errorReply, tabReply } from '../views.mjs';
import { SCENARIOS, architectureWithMetadata, context, flowList, links } from './pages-fixtures.mjs';

const repo = new URL('../../../../../', import.meta.url);
const schemaDir = new URL('calm-hub/src/main/resources/META-INF/calm-extensions/schema/0/', repo);
const extensionDir = new URL('../../extensions/service-health/', import.meta.url);
const json = (url) => JSON.parse(readFileSync(url, 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validate = {
    extension: ajv.compile(json(new URL('extension.schema.json', schemaDir))),
    blocks: ajv.compile(json(new URL('blocks.schema.json', schemaDir))),
    lens: ajv.compile(json(new URL('lens.schema.json', schemaDir))),
    notation: ajv.compile(json(new URL('notation.schema.json', schemaDir))),
};

function assertValid(check, value) {
    assert.ok(check(value), JSON.stringify(check.errors, null, 2));
}

describe('manifest', () => {
    const manifest = json(new URL('extension.json', extensionDir));
    const routes = new Map(manifest.routes.map((r) => [r.id, r]));
    const { contributes } = manifest;

    it('matches extension.schema.json', () => assertValid(validate.extension, manifest));

    it('declares the decorator view of decorators.mjs, and the simulation lens with a valid notation', () => {
        assert.deepEqual(contributes['decorator-views'], [DECORATOR_VIEW]);
        assert.deepEqual(contributes['diagram-lens'].map((l) => l.id), ['simulation']);
        assertValid(validate.notation, json(new URL('notation.json', extensionDir)));
    });

    it('uses only GET readOnly routes, so send-identity=false is allowed', () => {
        for (const route of manifest.routes) {
            assert.equal(route.method, 'GET', route.id);
            assert.equal(route.readOnly, true, route.id);
        }
    });

    it('checks the namespace scope on each route that names a resource', () => {
        for (const route of manifest.routes.filter((r) => r.path.includes('{namespace}'))) {
            assert.ok(['read', 'write'].includes(route.scope), route.id);
        }
        for (const route of manifest.routes.filter((r) => !r.path.includes('{'))) assert.equal(route.scope, 'authenticated', route.id);
    });
});

describe('replies match blocks.schema.json', () => {

    for (const [name, make] of SCENARIOS) {
        it(name, () => {
            const analysis = make();
            const replies = [
                tabReply({ analysis, flowNotes: ['A note.'], context, links }),
                tabReply({ analysis, context, links: {} }),
                flowStatusReply({ analysis, context, flowNotes: ['A note.'], links }),
                traceLinksScreen({ analysis, context, links: { tryIt: () => ({ label: 'Try it', href: 'http://localhost:9101/' }) } }),
                namespacesScreen({ summaries: [{ namespace: 'ns', id: '1', name: 'A', version: '1.0.0', analysis }, { namespace: 'ns', id: '2', name: 'B', error: 'x' }], namespaces: ['ns'] }),
                cardReply({ summaries: [{ namespace: 'ns', id: '1', name: 'A', version: '1.0.0', analysis }] }),
            ];
            for (const reply of replies) assertValid(validate.blocks, reply);
        });
    }

    it('an error reply', () => assertValid(validate.blocks, errorReply('x')));

    it('the simulation lens, and its panel blocks', () => {
        for (const fail of ['none', 'orders-api,central-db']) {
            const reply = simulationReply({ architecture: architectureWithMetadata(), flows: flowList(), fail });
            assertValid(validate.lens, reply);
            for (const block of reply.panels[0].blocks) assertValid(validate.blocks, { hubApi: 0, blocks: [block] });
        }
    });

    it('the check catches a reply that is not valid', () => {
        assert.equal(validate.blocks({ hubApi: 0, blocks: [{ type: 'table', columns: ['a'] }] }), false);
    });
});
