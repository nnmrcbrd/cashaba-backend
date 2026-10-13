import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRuntimeCompose } from './validate-runtime-compose.mjs';

const source = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : '/bin/bash';

// Run the real deployment script against disposable files and fake Docker
// commands. No Docker daemon, network, credentials or application database is used.
function scenario(failure = '', missingCompose = false) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cashaba-deploy-test-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'scripts'));
    fs.mkdirSync(path.join(temporaryRoot, 'bin'));
    fs.copyFileSync(source, path.join(temporaryRoot, 'scripts', 'deploy.sh'));
    if (!missingCompose) fs.writeFileSync(path.join(temporaryRoot, 'docker-compose.yaml'), 'name: cashaba-backend\nservices:\n  app:\n    image: fixture/backend\n');
    fs.writeFileSync(path.join(temporaryRoot, 'bin', 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(temporaryRoot, 'bin', 'docker'), `#!/usr/bin/env bash
set -eu
phase=unknown
for argument in "$@"; do
  case "$argument" in version|config|pull|run|up) phase="$argument"; break ;; esac
done
printf '%s\\n' "$phase" >> "$CASHABA_TEST_ROOT/calls.txt"
if [[ "$phase" == "$CASHABA_TEST_FAILURE" ]]; then exit 1; fi
if [[ "$phase" == up ]]; then
  [[ " $* " == *' --no-deps '* && " $* " == *' --wait '* && " $* " == *' app ' ]] || exit 97
fi
[[ "$phase" != unknown ]] || exit 98
`, { mode: 0o755 });
    const environment = { ...process.env, CASHABA_TEST_ROOT: temporaryRoot.replaceAll('\\', '/'), CASHABA_TEST_FAILURE: failure };
    const script = process.platform === 'win32'
      ? 'CASHABA_TEST_ROOT="$(cygpath -u "$CASHABA_TEST_ROOT")"; export CASHABA_TEST_ROOT; export PATH="$CASHABA_TEST_ROOT/bin:$PATH"; exec bash "$CASHABA_TEST_ROOT/scripts/deploy.sh"'
      : 'export PATH="$CASHABA_TEST_ROOT/bin:$PATH"; exec bash "$CASHABA_TEST_ROOT/scripts/deploy.sh"';
    const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: environment, timeout: 10_000, windowsHide: true });
    assert.equal(result.error, undefined);
    const log = path.join(temporaryRoot, 'calls.txt');
    return { status: result.status, output: result.stdout + result.stderr,
      calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  } finally {
    // Delete only the dedicated test directory created under the OS temp root.
    const resolved = path.resolve(temporaryRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cashaba-deploy-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('missing uploaded Compose file fails before any Docker command', () => {
  const result = scenario('', true);
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /Missing docker-compose.yaml/);
});

test('missing VPS environment/configuration never pulls or restarts the app', () => {
  const result = scenario('config');
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ['version', 'config']);
  assert.match(result.output, /Verify \/root\/env\/cashaba-backend\/\.env/);
});

test('failed image pull preserves the running app', () => {
  const result = scenario('pull');
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ['version', 'config', 'pull']);
});

test('failed production/database preflight never recreates the running app', () => {
  const result = scenario('run');
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ['version', 'config', 'pull', 'run']);
  assert.match(result.output, /Backend preflight failed/);
});

test('unhealthy rollout fails without claiming successful deployment', () => {
  const result = scenario('up');
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ['version', 'config', 'pull', 'run', 'up']);
  assert.doesNotMatch(result.output, /deployment completed/);
});

test('successful deployment checks readiness and recreates only the app service', () => {
  const result = scenario();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, ['version', 'config', 'pull', 'run', 'up']);
  assert.match(result.output, /deployment completed/);
});

function composeFixture() {
  return { services: { app: { environment: { PORT: '8000' },
    ports: [{ host_ip: '127.0.0.1', published: '8001', target: 8000 }] } } };
}

test('the VPS host port can differ from the backend container port', () => {
  assert.doesNotThrow(() => assertRuntimeCompose(composeFixture()));
});

test('a container PORT change cannot silently break the image health check', () => {
  const config = composeFixture();
  config.services.app.environment.PORT = '8001';
  assert.throws(() => assertRuntimeCompose(config), /PORT inside the app container must be 8000/);
});

test('a forwarding target mismatch is rejected before deployment', () => {
  const config = composeFixture();
  config.services.app.ports[0].target = 8001;
  assert.throws(() => assertRuntimeCompose(config), /Forward VPS loopback port 8001/);
});

test('extra frontend or managed-stack services are not deployed by this backend workflow', () => {
  const config = composeFixture();
  config.services.frontend = {};
  assert.throws(() => assertRuntimeCompose(config), /app-only backend/);
});
