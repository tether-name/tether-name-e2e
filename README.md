# tether-name-e2e

Cross-ecosystem end-to-end smoke tests for tether.name.

This repo runs a paced smoke matrix across:
- Node SDK (`tether-name`)
- Python SDK (`tether-name`)
- Go SDK (`github.com/tether-name/tether-name-go`)
- CLI (`tether-name-cli`)
- MCP server (`tether-name-mcp-server`)

## What it tests

The workflow exercises real API calls with cleanup:
- create/delete agents
- list domains
- challenge/proof verification
- key lifecycle list
- one rotate + one revoke flow (paced to reduce rate-limit collisions)

It writes artifacts:
- `e2e-summary.json`
- `e2e-summary.md`

## Required GitHub Secret

Add this repository secret before running Actions:

- `TETHER_E2E_API_KEY`

Use a scoped test key (not an unrestricted prod key).

## Run locally

```bash
npm ci
python -m pip install --upgrade pip
pip install tether-name
go mod download

export TETHER_E2E_API_KEY='sk-tether-name-...'
npm run e2e
```

## GitHub Actions

Workflow: `.github/workflows/e2e.yml`

Triggers:
- `workflow_dispatch` (manual)
- nightly schedule

## Safety notes

- This repo is public; never commit API keys.
- Tests use `e2e-*` resource names and attempt cleanup in all paths.
- Calls are intentionally paced to avoid key/challenge rate-limit false failures.
