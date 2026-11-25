// traces.mjs against replies captured from Tempo 3.0 (central-db DOWN; trimmed to a few series and one trace each).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FAILED_FLOWS_QUERY, FAILED_STEPS_QUERY, FLOWS_QUERY, FLOW_COUNTS_QUERY, LATEST_FLOWS_QUERY, STEPS_QUERY, STEP_COUNTS_QUERY,
    nodeFailuresTraceql, normaliseTraceId, readFlowTraces, searchUrl, seriesOf, spansOf, traceUrl,
} from '../traces.mjs';

const TEMPO = {
    "flowCounts": {
        "series": [
            {
                "labels": [
                    {
                        "key": "span.calm.flow.slug",
                        "value": {
                            "stringValue": "payment-reconciliation"
                        }
                    },
                    {
                        "key": "span.calm.flow.unique-id",
                        "value": {
                            "stringValue": "flow-payment-reconciliation"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "error"
                        }
                    }
                ],
                "value": 1
            },
            {
                "labels": [
                    {
                        "key": "span.calm.flow.slug",
                        "value": {
                            "stringValue": "payment-reconciliation"
                        }
                    },
                    {
                        "key": "span.calm.flow.unique-id",
                        "value": {
                            "stringValue": "flow-payment-reconciliation"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "unset"
                        }
                    }
                ],
                "value": 4
            },
            {
                "labels": [
                    {
                        "key": "span.calm.flow.slug",
                        "value": {
                            "stringValue": "place-order"
                        }
                    },
                    {
                        "key": "span.calm.flow.unique-id",
                        "value": {
                            "stringValue": "flow-place-order"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "error"
                        }
                    }
                ],
                "value": 1
            },
            {
                "labels": [
                    {
                        "key": "span.calm.flow.slug",
                        "value": {
                            "stringValue": "place-order"
                        }
                    },
                    {
                        "key": "span.calm.flow.unique-id",
                        "value": {
                            "stringValue": "flow-place-order"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "unset"
                        }
                    }
                ],
                "value": 4
            }
        ],
        "metrics": {
            "completedJobs": 1,
            "totalJobs": 1
        }
    },
    "stepCounts": {
        "series": [
            {
                "labels": [
                    {
                        "key": "span.calm.relationship.unique-id",
                        "value": {
                            "stringValue": "customer-portal-to-api-gateway"
                        }
                    },
                    {
                        "key": "span.calm.step.from",
                        "value": {
                            "stringValue": "customer-portal"
                        }
                    },
                    {
                        "key": "span.calm.step.to",
                        "value": {
                            "stringValue": "api-gateway"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "unset"
                        }
                    }
                ],
                "value": 55
            },
            {
                "labels": [
                    {
                        "key": "span.calm.relationship.unique-id",
                        "value": {
                            "stringValue": "orders-api-to-central-db"
                        }
                    },
                    {
                        "key": "span.calm.step.from",
                        "value": {
                            "stringValue": "orders-api"
                        }
                    },
                    {
                        "key": "span.calm.step.to",
                        "value": {
                            "stringValue": "central-db"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "unset"
                        }
                    }
                ],
                "value": 36
            },
            {
                "labels": [
                    {
                        "key": "span.calm.relationship.unique-id",
                        "value": {
                            "stringValue": "orders-api-to-central-db"
                        }
                    },
                    {
                        "key": "span.calm.step.from",
                        "value": {
                            "stringValue": "orders-api"
                        }
                    },
                    {
                        "key": "span.calm.step.to",
                        "value": {
                            "stringValue": "central-db"
                        }
                    },
                    {
                        "key": "span.calm.failure.node",
                        "value": {
                            "stringValue": "central-db"
                        }
                    },
                    {
                        "key": "status",
                        "value": {
                            "stringValue": "error"
                        }
                    }
                ],
                "value": 8
            }
        ],
        "metrics": {
            "completedJobs": 1,
            "totalJobs": 1
        }
    },
    "failedFlows": {
        "traces": [
            {
                "traceID": "281e303cbff55f686e89bed0212ea4cc",
                "rootServiceName": "flow-driver",
                "rootTraceName": "flow Payment Reconciliation",
                "startTimeUnixNano": "1795618320638662833",
                "durationMs": 85,
                "spanSet": {
                    "spans": [
                        {
                            "spanID": "235e311add037c46",
                            "startTimeUnixNano": "1795618320638662833",
                            "durationNanos": "84765958",
                            "attributes": [
                                {
                                    "key": "calm.flow.failed-relationship",
                                    "value": {
                                        "stringValue": "orders-api-to-central-db"
                                    }
                                },
                                {
                                    "key": "calm.flow.failed-step",
                                    "value": {
                                        "intValue": "3"
                                    }
                                },
                                {
                                    "key": "calm.flow.failure-reason",
                                    "value": {
                                        "stringValue": "central-db replied 503: central-db is DOWN"
                                    }
                                },
                                {
                                    "key": "status",
                                    "value": {
                                        "stringValue": "error"
                                    }
                                },
                                {
                                    "key": "calm.flow.unique-id",
                                    "value": {
                                        "stringValue": "flow-payment-reconciliation"
                                    }
                                },
                                {
                                    "key": "statusMessage",
                                    "value": {
                                        "stringValue": "step 3 orders-api-to-central-db: central-db replied 503: central-db is DOWN"
                                    }
                                },
                                {
                                    "key": "calm.flow.slug",
                                    "value": {
                                        "stringValue": "payment-reconciliation"
                                    }
                                },
                                {
                                    "key": "calm.flow.failed-node",
                                    "value": {
                                        "stringValue": "central-db"
                                    }
                                }
                            ]
                        }
                    ],
                    "matched": 1
                },
                "spanSets": [
                    {
                        "spans": [
                            {
                                "spanID": "235e311add037c46",
                                "startTimeUnixNano": "1795618320638662833",
                                "durationNanos": "84765958",
                                "attributes": [
                                    {
                                        "key": "calm.flow.failed-relationship",
                                        "value": {
                                            "stringValue": "orders-api-to-central-db"
                                        }
                                    },
                                    {
                                        "key": "calm.flow.failed-step",
                                        "value": {
                                            "intValue": "3"
                                        }
                                    },
                                    {
                                        "key": "calm.flow.failure-reason",
                                        "value": {
                                            "stringValue": "central-db replied 503: central-db is DOWN"
                                        }
                                    },
                                    {
                                        "key": "status",
                                        "value": {
                                            "stringValue": "error"
                                        }
                                    },
                                    {
                                        "key": "calm.flow.unique-id",
                                        "value": {
                                            "stringValue": "flow-payment-reconciliation"
                                        }
                                    },
                                    {
                                        "key": "statusMessage",
                                        "value": {
                                            "stringValue": "step 3 orders-api-to-central-db: central-db replied 503: central-db is DOWN"
                                        }
                                    },
                                    {
                                        "key": "calm.flow.slug",
                                        "value": {
                                            "stringValue": "payment-reconciliation"
                                        }
                                    },
                                    {
                                        "key": "calm.flow.failed-node",
                                        "value": {
                                            "stringValue": "central-db"
                                        }
                                    }
                                ]
                            }
                        ],
                        "matched": 1
                    }
                ],
                "serviceStats": {
                    "admin-console": {
                        "spanCount": 1
                    },
                    "api-gateway": {
                        "spanCount": 2
                    },
                    "central-db": {
                        "spanCount": 1,
                        "errorCount": 1
                    },
                    "flow-driver": {
                        "spanCount": 4,
                        "errorCount": 2
                    },
                    "orders-api": {
                        "spanCount": 2,
                        "errorCount": 1
                    }
                }
            }
        ],
        "metrics": {
            "inspectedBytes": "131928",
            "completedJobs": 2,
            "totalJobs": 2
        }
    },
    "failedSteps": {
        "traces": [
            {
                "traceID": "281e303cbff55f686e89bed0212ea4cc",
                "rootServiceName": "flow-driver",
                "rootTraceName": "flow Payment Reconciliation",
                "startTimeUnixNano": "1795618320638662833",
                "durationMs": 85,
                "spanSet": {
                    "spans": [
                        {
                            "spanID": "09d8fb7192e25c16",
                            "startTimeUnixNano": "1795618320720188000",
                            "durationNanos": "3220541",
                            "attributes": [
                                {
                                    "key": "calm.flow.step",
                                    "value": {
                                        "intValue": "3"
                                    }
                                },
                                {
                                    "key": "calm.failure.node",
                                    "value": {
                                        "stringValue": "central-db"
                                    }
                                },
                                {
                                    "key": "statusMessage",
                                    "value": {
                                        "stringValue": "central-db replied 503: central-db is DOWN"
                                    }
                                },
                                {
                                    "key": "calm.step.to",
                                    "value": {
                                        "stringValue": "central-db"
                                    }
                                },
                                {
                                    "key": "status",
                                    "value": {
                                        "stringValue": "error"
                                    }
                                },
                                {
                                    "key": "calm.flow.unique-id",
                                    "value": {
                                        "stringValue": "flow-payment-reconciliation"
                                    }
                                },
                                {
                                    "key": "calm.relationship.unique-id",
                                    "value": {
                                        "stringValue": "orders-api-to-central-db"
                                    }
                                },
                                {
                                    "key": "calm.step.from",
                                    "value": {
                                        "stringValue": "orders-api"
                                    }
                                },
                                {
                                    "key": "calm.failure.reason",
                                    "value": {
                                        "stringValue": "central-db replied 503: central-db is DOWN"
                                    }
                                }
                            ]
                        }
                    ],
                    "matched": 1
                },
                "spanSets": [
                    {
                        "spans": [
                            {
                                "spanID": "09d8fb7192e25c16",
                                "startTimeUnixNano": "1795618320720188000",
                                "durationNanos": "3220541",
                                "attributes": [
                                    {
                                        "key": "calm.flow.step",
                                        "value": {
                                            "intValue": "3"
                                        }
                                    },
                                    {
                                        "key": "calm.failure.node",
                                        "value": {
                                            "stringValue": "central-db"
                                        }
                                    },
                                    {
                                        "key": "statusMessage",
                                        "value": {
                                            "stringValue": "central-db replied 503: central-db is DOWN"
                                        }
                                    },
                                    {
                                        "key": "calm.step.to",
                                        "value": {
                                            "stringValue": "central-db"
                                        }
                                    },
                                    {
                                        "key": "status",
                                        "value": {
                                            "stringValue": "error"
                                        }
                                    },
                                    {
                                        "key": "calm.flow.unique-id",
                                        "value": {
                                            "stringValue": "flow-payment-reconciliation"
                                        }
                                    },
                                    {
                                        "key": "calm.relationship.unique-id",
                                        "value": {
                                            "stringValue": "orders-api-to-central-db"
                                        }
                                    },
                                    {
                                        "key": "calm.step.from",
                                        "value": {
                                            "stringValue": "orders-api"
                                        }
                                    },
                                    {
                                        "key": "calm.failure.reason",
                                        "value": {
                                            "stringValue": "central-db replied 503: central-db is DOWN"
                                        }
                                    }
                                ]
                            }
                        ],
                        "matched": 1
                    }
                ],
                "serviceStats": {
                    "admin-console": {
                        "spanCount": 1
                    },
                    "api-gateway": {
                        "spanCount": 2
                    },
                    "central-db": {
                        "spanCount": 1,
                        "errorCount": 1
                    },
                    "flow-driver": {
                        "spanCount": 4,
                        "errorCount": 2
                    },
                    "orders-api": {
                        "spanCount": 2,
                        "errorCount": 1
                    }
                }
            }
        ],
        "metrics": {
            "inspectedBytes": "131928",
            "completedJobs": 2,
            "totalJobs": 2
        }
    }
};

const NOW = Date.parse('2026-11-25T14:53:00Z');
const FAILED_TRACE = '281e303cbff55f686e89bed0212ea4cc';

// replies: { [q]: body } for /api/metrics/query and /api/search. Others give a 400.
function stub(replies, calls = []) {
    return async (url) => {
        calls.push(url);
        const body = replies[url.searchParams.get('q')];
        if (!body) return new Response('{"error":"unknown query"}', { status: 400 });
        return Response.json(body);
    };
}

const LIVE = {
    [FLOW_COUNTS_QUERY]: TEMPO.flowCounts,
    [STEP_COUNTS_QUERY]: TEMPO.stepCounts,
    [FAILED_FLOWS_QUERY]: TEMPO.failedFlows,
    [FAILED_STEPS_QUERY]: TEMPO.failedSteps,
    [LATEST_FLOWS_QUERY]: TEMPO.failedFlows,
};

describe('readFlowTraces', () => {
    it('counts flows and gives the last failure with its step, relationship, node and reason', async () => {
        const calls = [];
        const result = await readFlowTraces('http://tempo:3200', { fetchImpl: stub(LIVE, calls), now: NOW, minutes: 15, grafanaUrl: 'http://g:3000' });
        assert.equal(result.available, true);
        assert.equal(result.method, 'traceql-metrics');
        assert.deepEqual(result.window, { start: '2026-11-25T14:38:00.000Z', end: '2026-11-25T14:53:00.000Z', minutes: 15 });
        const { searchUrl: link, lastRun, ...recon } = result.flows['payment-reconciliation'];
        assert.deepEqual(lastRun, { traceId: FAILED_TRACE, time: recon.lastFailed.time, traceUrl: traceUrl('http://g:3000', FAILED_TRACE) });
        assert.deepEqual(recon, {
            slug: 'payment-reconciliation', id: 'flow-payment-reconciliation', total: 5, failed: 1, errorRatio: 0.2,
            lastFailed: {
                traceId: FAILED_TRACE,
                time: new Date(Number(BigInt(TEMPO.failedFlows.traces[0].startTimeUnixNano) / 1_000_000n)).toISOString(),
                failedStep: 3,
                relationship: 'orders-api-to-central-db',
                node: 'central-db',
                reason: 'central-db replied 503: central-db is DOWN',
                traceUrl: traceUrl('http://g:3000', FAILED_TRACE),
            },
        });
        assert.equal(JSON.parse(new URL(link).searchParams.get('panes')).traces.queries[0].query,
            '{ span."calm.flow.slug" = "payment-reconciliation" && status = error }');
        assert.equal(result.flows['place-order'].failed, 1);
        assert.equal(result.flows['place-order'].lastFailed, null);

        const sent = calls.map((url) => [url.pathname, url.searchParams.get('start'), url.searchParams.get('end'), url.searchParams.get('q')]);
        // The latest runs: the last 2 minutes only.
        assert.ok(sent.every(([, start, end, q]) => start === String(NOW / 1000 - (q === LATEST_FLOWS_QUERY ? 120 : 900)) && end === String(NOW / 1000)));
        assert.deepEqual(sent.map(([path]) => path).sort(), ['/api/metrics/query', '/api/metrics/query', '/api/search', '/api/search', '/api/search']);
        assert.equal(result.flows['place-order'].lastRun, null);
    });

    it('attributes step failures to the failing node and the relationship', async () => {
        const result = await readFlowTraces('http://tempo:3200', { fetchImpl: stub(LIVE), now: NOW });
        const rel = result.byRelationship['orders-api-to-central-db'];
        assert.deepEqual({ ...rel, searchUrl: undefined, lastFailed: undefined }, {
            source: 'orders-api', destination: 'central-db', total: 44, failed: 8, errorRatio: 8 / 44, searchUrl: undefined, lastFailed: undefined,
        });
        assert.deepEqual({ ...rel.lastFailed, traceUrl: undefined }, {
            traceId: FAILED_TRACE, time: rel.lastFailed.time, reason: 'central-db replied 503: central-db is DOWN',
            flow: 'flow-payment-reconciliation', step: 3, node: 'central-db', traceUrl: undefined,
        });
        assert.equal(result.byNode['central-db'].failed, 8);
        assert.equal(result.byNode['central-db'].total, 44);
        assert.equal(result.byNode['central-db'].lastFailed.relationship, 'orders-api-to-central-db');
        assert.equal(result.byNode['orders-api'].failed, 0, 'the caller of a failed call is not blamed');
        assert.equal(result.byNode['orders-api'].total, 44);
        assert.equal(result.byNode['customer-portal'].total, 55);
        assert.equal(result.byNode['api-gateway'].errorRatio, 0);
        assert.equal(JSON.parse(new URL(result.byNode['central-db'].searchUrl).searchParams.get('panes')).traces.queries[0].query,
            nodeFailuresTraceql('central-db'));
    });

    it('counts by search when Tempo cannot answer TraceQL metrics', async () => {
        const failedRoot = TEMPO.failedFlows.traces[0];
        const okRoot = { ...failedRoot, traceID: 'ab', spanSet: undefined, spanSets: [{ spans: [{ spanID: '1', startTimeUnixNano: '1', attributes: [
            { key: 'calm.flow.slug', value: { stringValue: 'payment-reconciliation' } }, { key: 'status', value: { stringValue: 'unset' } }] }] }] };
        const result = await readFlowTraces('http://tempo:3200', {
            now: NOW,
            fetchImpl: stub({
                [FLOWS_QUERY]: { traces: [failedRoot, okRoot] },
                [STEPS_QUERY]: TEMPO.failedSteps,
                [FAILED_FLOWS_QUERY]: TEMPO.failedFlows,
                [FAILED_STEPS_QUERY]: TEMPO.failedSteps,
            }),
        });
        assert.equal(result.method, 'search');
        assert.deepEqual([result.flows['payment-reconciliation'].total, result.flows['payment-reconciliation'].failed], [2, 1]);
        assert.deepEqual([result.byNode['central-db'].total, result.byNode['central-db'].failed], [1, 1]);
    });

    it('falls back to the span status message for the reason', async () => {
        const trace = structuredClone(TEMPO.failedSteps.traces[0]);
        for (const set of [trace.spanSet, ...trace.spanSets]) {
            set.spans[0].attributes = set.spans[0].attributes.filter((a) => !['calm.failure.reason', 'calm.failure.node'].includes(a.key));
        }
        const result = await readFlowTraces('http://tempo:3200', { now: NOW, fetchImpl: stub({ ...LIVE, [FAILED_STEPS_QUERY]: { traces: [trace] } }) });
        assert.equal(result.byRelationship['orders-api-to-central-db'].lastFailed.reason, 'central-db replied 503: central-db is DOWN');
        assert.equal(result.byNode['central-db'].lastFailed.traceId, FAILED_TRACE, 'without calm.failure.node the destination is blamed');
    });

    it('keeps span attribute values such as __proto__ as plain keys', async () => {
        const label = (key, value) => ({ key: `span.${key}`, value: { stringValue: value } });
        const series = (labels) => ({ labels, value: 3 });
        const result = await readFlowTraces('http://tempo:3200', {
            now: NOW,
            fetchImpl: stub({
                [FLOW_COUNTS_QUERY]: { series: [series([label('calm.flow.slug', '__proto__'), { key: 'status', value: { stringValue: 'error' } }])] },
                [STEP_COUNTS_QUERY]: { series: [series([label('calm.relationship.unique-id', '__proto__'), label('calm.step.from', 'constructor'),
                    label('calm.step.to', '__proto__')])] },
                [FAILED_FLOWS_QUERY]: { traces: [] },
                [FAILED_STEPS_QUERY]: { traces: [] },
            }),
        });
        assert.equal(result.available, true);
        assert.equal(result.flows.__proto__.failed, 3);
        assert.equal(result.byNode.__proto__.inbound, 3);
        assert.equal(result.byNode.constructor.total, 3);
        assert.equal(result.byRelationship.__proto__.total, 3);
        assert.equal({}.total, undefined);
        assert.equal({}.failed, undefined);
    });

    it('never throws: unreachable, error replies, bad replies and timeouts give available false', async () => {
        const cases = [
            [async () => { throw new TypeError('fetch failed'); }, 'fetch failed'],
            [async () => new Response('', { status: 500 }), /Tempo replied 500/],
            [async () => Response.json({ nope: true }), /unexpected search reply/],
            [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'Tempo did not answer in time'],
        ];
        for (const [fetchImpl, error] of cases) {
            const result = await readFlowTraces('http://tempo:3200', { fetchImpl, now: NOW });
            assert.equal(result.available, false);
            if (error instanceof RegExp) assert.match(result.error, error);
            else assert.equal(result.error, error);
        }
    });
});

describe('Tempo reply parsing', () => {
    it('pads trace ids that Tempo returns without leading zeros', () => {
        assert.equal(normaliseTraceId('ccbf90a8e9028903f4ac590d1fdffaa'), '0ccbf90a8e9028903f4ac590d1fdffaa');
        assert.equal(normaliseTraceId('ABC'), '0'.repeat(29) + 'abc');
    });

    it('reads each matched span once, most recent first, with typed attributes', () => {
        const spans = spansOf({ traces: [
            { traceID: 'a', spanSets: [{ spans: [{ spanID: 's1', startTimeUnixNano: '1000000', attributes: [{ key: 'calm.flow.step', value: { intValue: '3' } }] }] }],
                spanSet: { spans: [{ spanID: 's1', startTimeUnixNano: '1000000' }] } },
            { traceID: 'b', spanSet: { spans: [{ spanID: 's2', startTimeUnixNano: '2000000', attributes: [{ key: 'x', value: { boolValue: true } }] }] } },
        ] });
        assert.deepEqual(spans.map((s) => [s.traceId.slice(-1), s.time, s.attributes]), [
            ['b', '1970-01-01T00:00:00.002Z', { x: true }],
            ['a', '1970-01-01T00:00:00.001Z', { 'calm.flow.step': 3 }],
        ]);
        assert.throws(() => spansOf({}), /unexpected search reply/);
    });

    it('strips the span. prefix from metrics labels and skips non-numeric values', () => {
        assert.deepEqual(seriesOf({ series: [
            { labels: [{ key: 'span.calm.flow.slug', value: { stringValue: 'x' } }, { key: 'status', value: { stringValue: 'error' } }], value: 2 },
            { labels: [], value: 'NaN' },
        ] }), [{ labels: { 'calm.flow.slug': 'x', status: 'error' }, value: 2 }]);
        assert.throws(() => seriesOf({}), /unexpected metrics reply/);
    });
});

describe('Grafana links', () => {
    const panesOf = (href) => JSON.parse(new URL(href).searchParams.get('panes')).traces;

    it('traceUrl opens one trace in Explore with the Tempo datasource', () => {
        const href = traceUrl('http://localhost:3000/d/service-health/service-health', 'ccbf90a8e9028903f4ac590d1fdffaa');
        assert.ok(href.startsWith('http://localhost:3000/explore?schemaVersion=1&panes='));
        const pane = panesOf(href);
        assert.equal(pane.datasource, 'tempo');
        assert.deepEqual(pane.queries[0].datasource, { type: 'tempo', uid: 'tempo' });
        assert.equal(pane.queries[0].queryType, 'traceql');
        assert.equal(pane.queries[0].query, '0ccbf90a8e9028903f4ac590d1fdffaa');
    });

    it('searchUrl runs a TraceQL search over the window', () => {
        const pane = panesOf(searchUrl('http://localhost:3000', nodeFailuresTraceql('payments-api'), { minutes: 30 }));
        assert.equal(pane.queries[0].query, '{ span."calm.failure.node" = "payments-api" }');
        assert.deepEqual(pane.range, { from: 'now-30m', to: 'now' });
    });
});
