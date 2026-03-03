#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';

import { TetherClient } from 'tether-name';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const API_KEY = process.env.TETHER_E2E_API_KEY || process.env.TETHER_API_KEY;
const API_BASE = process.env.TETHER_E2E_API_BASE_URL || process.env.TETHER_API_BASE_URL || 'https://api.tether.name';
const SUFFIX = `${Math.floor(Date.now() / 1000)}-${process.pid}`;
const CLI_BIN = path.resolve('node_modules/.bin/tether');

if (!API_KEY) {
  console.error('Missing TETHER_E2E_API_KEY (or TETHER_API_KEY).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logStep(msg) {
  console.log(`\n[STEP] ${msg}`);
}

function writePemAndPublic(filePath) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  fs.writeFileSync(filePath, privateKey);
  return Buffer.from(publicKey).toString('base64');
}

async function apiRequest(method, endpoint, body, { auth = false, retries = 8 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${API_KEY}`;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const raw = await res.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = raw; }

    if (res.status === 429 && attempt < retries - 1) {
      await sleep(Math.min(15000 + attempt * 8000, 90000));
      continue;
    }

    return { status: res.status, payload };
  }

  return { status: 599, payload: { error: 'retry_exhausted' } };
}

function assertStatus({ status, payload }, expected, context) {
  if (!expected.includes(status)) {
    throw new Error(`${context} failed: status=${status} payload=${JSON.stringify(payload)}`);
  }
}

function parseJsonLoose(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty output');
  try { return JSON.parse(trimmed); } catch {}

  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const starts = [firstObj, firstArr].filter((v) => v >= 0).sort((a, b) => a - b);
  if (starts.length > 0) {
    const start = starts[0];
    const candidate = trimmed.slice(start);
    try { return JSON.parse(candidate); } catch {}
  }

  const lastObj = trimmed.lastIndexOf('{');
  const lastArr = trimmed.lastIndexOf('[');
  const start = Math.max(lastObj, lastArr);
  if (start >= 0) {
    const candidate = trimmed.slice(start);
    return JSON.parse(candidate);
  }

  throw new Error(`unable to parse json from output: ${text}`);
}

function runCommand(cmd, args, { env = {}, retries = 3, cwd = process.cwd() } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const proc = spawnSync(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });

    if (proc.status === 0) {
      return proc.stdout.trim();
    }

    const combined = `${proc.stdout || ''}\n${proc.stderr || ''}`;
    const rateLimited = /429|Too Many Requests/i.test(combined);
    if (rateLimited && attempt < retries - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(30000 + attempt * 20000, 90000));
      continue;
    }

    throw new Error(`command failed: ${cmd} ${args.join(' ')}\n${combined}`);
  }

  throw new Error(`command retries exhausted: ${cmd}`);
}

async function requestChallenge() {
  const response = await apiRequest('POST', '/challenge', {}, { auth: false, retries: 10 });
  assertStatus(response, [200], 'request challenge');
  return response.payload.code;
}

function parseToolJson(result) {
  const text = (result?.content || []).find((c) => c.type === 'text')?.text || '{}';
  return parseJsonLoose(text);
}

async function main() {
  const results = {};
  const notes = [];
  let lifecycleAgentId = null;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-e2e-'));
  const lifecycleKeyPath = path.join(tempDir, 'lifecycle.pem');

  try {
    logStep('Cleanup stale e2e lifecycle agents');
    const listAgents = await apiRequest('GET', '/agents', undefined, { auth: true });
    if (listAgents.status === 200 && Array.isArray(listAgents.payload)) {
      for (const agent of listAgents.payload) {
        if ((agent.agentName || '').startsWith('e2e-lifecycle-')) {
          await apiRequest('DELETE', `/agents/${agent.id}`, undefined, { auth: true });
        }
      }
    }

    logStep('Create lifecycle agent and register key');
    const lifecyclePublicKey = writePemAndPublic(lifecycleKeyPath);
    const created = await apiRequest('POST', '/agents/issue', {
      agentName: `e2e-lifecycle-${SUFFIX}`,
      description: 'cross-sdk e2e lifecycle agent',
    }, { auth: true });
    assertStatus(created, [201], 'create lifecycle agent');

    lifecycleAgentId = created.payload.id;

    const registered = await apiRequest('POST', `/agents/${lifecycleAgentId}/register-key`, {
      registrationToken: created.payload.registrationToken,
      publicKey: lifecyclePublicKey,
    });
    assertStatus(registered, [200], 'register lifecycle key');

    // ---------- Node SDK ----------
    logStep('Node SDK surface');
    try {
      const nodeMgmt = new TetherClient({ apiKey: API_KEY, baseUrl: API_BASE });
      const nodeSigner = new TetherClient({
        agentId: lifecycleAgentId,
        privateKeyPath: lifecycleKeyPath,
        baseUrl: API_BASE,
      });

      const nodeNewPub = writePemAndPublic(path.join(tempDir, 'node-new.pem'));
      const verifyChallenge = await requestChallenge();
      const rotateChallenge = await requestChallenge();

      const domains = await nodeMgmt.listDomains();
      const tempAgent = await nodeMgmt.createAgent(`e2e-node-${SUFFIX}`, 'node e2e surface');
      const verify = await nodeSigner.submitProof(verifyChallenge, nodeSigner.sign(verifyChallenge));
      const rotate = await nodeMgmt.rotateAgentKey(lifecycleAgentId, {
        publicKey: nodeNewPub,
        gracePeriodHours: 1,
        reason: 'e2e_node_rotate',
        challenge: rotateChallenge,
        proof: nodeSigner.sign(rotateChallenge),
      });
      const keys = await nodeMgmt.listAgentKeys(lifecycleAgentId);
      await nodeMgmt.deleteAgent(tempAgent.id);

      results.node = {
        pass: true,
        surface: 'node',
        domainsCount: domains.length,
        verifyOk: verify.verified === true,
        rotatedKeyId: rotate.newKeyId,
        keysCount: keys.length,
      };
    } catch (error) {
      results.node = { pass: false, surface: 'node', error: String(error) };
    }

    await sleep(20000);

    // ---------- Python SDK ----------
    logStep('Python SDK surface');
    try {
      const pyOut = runCommand('python3', ['scripts/surface-python.py'], {
        env: {
          TETHER_API_KEY: API_KEY,
          LIFECYCLE_AGENT_ID: lifecycleAgentId,
          LIFECYCLE_PRIVATE_KEY_PATH: lifecycleKeyPath,
          E2E_SUFFIX: SUFFIX,
          PY_VERIFY_CHALLENGE: await requestChallenge(),
        },
      });
      results.python = parseJsonLoose(pyOut);
    } catch (error) {
      results.python = { pass: false, surface: 'python', error: String(error) };
    }

    await sleep(20000);

    // ---------- Go SDK (revoke Node rotated key) ----------
    logStep('Go SDK surface');
    const revokeKeyId = results.node?.rotatedKeyId;
    if (!revokeKeyId) {
      results.go = { pass: false, surface: 'go', error: 'Skipped: missing node rotatedKeyId' };
    } else {
      try {
        const goOut = runCommand('go', ['run', 'scripts/surface-go.go'], {
          env: {
            TETHER_API_KEY: API_KEY,
            LIFECYCLE_AGENT_ID: lifecycleAgentId,
            LIFECYCLE_PRIVATE_KEY_PATH: lifecycleKeyPath,
            GO_REVOKE_CHALLENGE: await requestChallenge(),
            GO_REVOKE_KEY_ID: revokeKeyId,
            E2E_SUFFIX: SUFFIX,
          },
        });
        results.go = parseJsonLoose(goOut);
      } catch (error) {
        results.go = { pass: false, surface: 'go', error: String(error) };
      }
    }

    await sleep(20000);

    // ---------- CLI ----------
    logStep('CLI surface');
    try {
      const domains = parseJsonLoose(runCommand(CLI_BIN, ['domain', 'list', '--api-key', API_KEY, '--json']));
      const createdAgent = parseJsonLoose(runCommand(CLI_BIN, ['agent', 'create', `e2e-cli-${SUFFIX}`, '--description', 'cli e2e surface', '--api-key', API_KEY, '--json']));
      const keys = parseJsonLoose(runCommand(CLI_BIN, ['agent', 'keys', lifecycleAgentId, '--api-key', API_KEY, '--json']));
      const signChallenge = await requestChallenge();
      const proof = runCommand(CLI_BIN, ['sign', signChallenge, '--key-path', lifecycleKeyPath]).trim();
      runCommand(CLI_BIN, ['agent', 'delete', createdAgent.id, '--api-key', API_KEY, '--json']);

      results.cli = {
        pass: true,
        surface: 'cli',
        domainsCount: Array.isArray(domains) ? domains.length : -1,
        keysCount: Array.isArray(keys) ? keys.length : -1,
        signProofLength: proof.length,
      };
    } catch (error) {
      results.cli = { pass: false, surface: 'cli', error: String(error) };
    }

    await sleep(20000);

    // ---------- MCP ----------
    logStep('MCP surface');
    try {
      const verifyChallenge = await requestChallenge();
      const transport = new StdioClientTransport({
        command: path.resolve('node_modules/.bin/tether-name-mcp-server'),
        env: {
          ...process.env,
          TETHER_API_KEY: API_KEY,
          TETHER_AGENT_ID: lifecycleAgentId,
          TETHER_PRIVATE_KEY_PATH: lifecycleKeyPath,
          TETHER_BASE_URL: API_BASE,
        },
      });
      const mcp = new Client({ name: 'tether-name-e2e', version: '0.1.0' });
      await mcp.connect(transport);

      let tempAgentId = null;
      try {
        const tools = await mcp.listTools();
        const coreToolsPresent = ['create_agent', 'delete_agent', 'list_agent_keys', 'sign_challenge', 'submit_proof'].every((n) =>
          tools.tools.some((t) => t.name === n),
        );

        const domains = parseToolJson(await mcp.callTool({ name: 'list_domains', arguments: {} }));
        const created = parseToolJson(await mcp.callTool({
          name: 'create_agent',
          arguments: { agentName: `e2e-mcp-${SUFFIX}`, description: 'mcp e2e surface' },
        }));
        tempAgentId = created.id;

        const signed = parseToolJson(await mcp.callTool({ name: 'sign_challenge', arguments: { challenge: verifyChallenge } }));
        const verify = parseToolJson(await mcp.callTool({
          name: 'submit_proof',
          arguments: { challenge: verifyChallenge, proof: signed.proof },
        }));
        const keys = parseToolJson(await mcp.callTool({
          name: 'list_agent_keys',
          arguments: { agentId: lifecycleAgentId },
        }));

        await mcp.callTool({ name: 'delete_agent', arguments: { agentId: tempAgentId } });
        tempAgentId = null;

        results.mcp = {
          pass: true,
          surface: 'mcp',
          coreToolsPresent,
          domainsCount: Array.isArray(domains) ? domains.length : -1,
          verifyOk: verify.verified === true,
          keysCount: Array.isArray(keys) ? keys.length : -1,
        };
      } finally {
        if (tempAgentId) {
          try { await mcp.callTool({ name: 'delete_agent', arguments: { agentId: tempAgentId } }); } catch {}
        }
        await mcp.close();
        await transport.close();
      }
    } catch (error) {
      results.mcp = { pass: false, surface: 'mcp', error: String(error) };
    }

    // Final lifecycle snapshot
    const finalKeysRes = await apiRequest('GET', `/agents/${lifecycleAgentId}/keys`, undefined, { auth: true });
    const finalKeys = finalKeysRes.status === 200 && Array.isArray(finalKeysRes.payload) ? finalKeysRes.payload : [];

    const summary = {
      ok: Object.values(results).every((r) => r.pass === true),
      timestamp: new Date().toISOString(),
      apiBase: API_BASE,
      lifecycleAgentId,
      results,
      finalKeysCount: finalKeys.length,
      finalActiveKeys: finalKeys.filter((k) => k.status === 'active').map((k) => k.id),
      notes,
    };

    fs.writeFileSync('e2e-summary.json', JSON.stringify(summary, null, 2));
    console.log('\n===== E2E SUMMARY =====');
    console.log(JSON.stringify(summary, null, 2));

    const lines = [
      '# tether-name-e2e summary',
      '',
      `- ok: **${summary.ok}**`,
      `- apiBase: \`${summary.apiBase}\``,
      `- lifecycleAgentId: \`${summary.lifecycleAgentId}\``,
      '',
      '| Surface | Pass | Notes |',
      '|---|---|---|',
      ...Object.entries(results).map(([name, result]) => `| ${name} | ${result.pass ? '✅' : '❌'} | ${result.error ? String(result.error).replace(/\|/g, '\\|') : 'ok'} |`),
      '',
      `- finalKeysCount: ${summary.finalKeysCount}`,
      `- finalActiveKeys: ${summary.finalActiveKeys.join(', ') || '(none)'}`,
    ];
    fs.writeFileSync('e2e-summary.md', lines.join('\n'));

    if (!summary.ok) process.exitCode = 1;
  } finally {
    if (lifecycleAgentId) {
      await apiRequest('DELETE', `/agents/${lifecycleAgentId}`, undefined, { auth: true, retries: 4 });
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
