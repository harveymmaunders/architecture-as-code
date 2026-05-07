# CALM CLI — Local Testing Guide

This folder contains example decorator files for testing the `calm validate -d` command locally.

---

## Setup

### 1. Install dependencies and build

From the repository root:

```bash
npm install
npm run build:cli
```

This compiles the CLI to `cli/dist/index.js`.

### 2. Run the CLI

You can invoke the CLI directly:

```bash
node cli/dist/index.js validate --help
```

Or link it globally so the `calm` binary is available on your PATH:

```bash
cd cli
alias calm="dist/index.js"
calm validate --help
```

---

## Validate a Standard Decorator (Guide)

A base decorator of type `guide`. This attaches documentation guidance to a set of architecture nodes.

```bash
# Test guide decorator with no errors
calm validate -d local-testing/decorators/guide-decorator.json --format pretty
```

**Expected output:** validation passes with no errors.

---

## Validate a Deployment Decorator with Errors

This decorator has two problems that the base decorator schema catches:

1. **`applies-to` is missing** — this is a required field on every decorator.
2. **`environment` is an extra top-level property** — the base schema uses `additionalProperties: false`, so any property not in the schema (`unique-id`, `type`, `target-type`, `target`, `applies-to`, `data`) is rejected.

```bash
# Test "deployment" decorator with errors
calm validate -d local-testing/decorators/deployment-decorator-errors.json --format pretty
```

**Expected output:** validation fails with two schema errors at the root level.

---

## Validate the Fixed Deployment Decorator

The corrected version of the above — `status` is set to `"completed"` and `start-time` is provided.

```bash
# Test fixed "deployment" decorator
calm validate -d local-testing/decorators/deployment-decorator-fixed.json --format pretty
```

**Expected output:** validation passes with no errors.

---

## Validate a Kubernetes Deployment Decorator

A deployment decorator with Kubernetes-specific fields (`cluster`, `namespace`, `image-tag`, etc.) in the `data` object. The deployment standard allows additional properties in `data`, so these pass through cleanly.

```bash
# Test a more specific type of decorator
calm validate -d local-testing/decorators/kubernetes-deployment-decorator.json --format pretty
```

**Expected output:** validation passes with no errors.
