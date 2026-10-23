import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const gitDirectory = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git');
const bash = process.platform === 'win32' ? path.join(gitDirectory, 'bin', 'bash.exe') : '/bin/bash';
const keygen = process.platform === 'win32' ? path.join(gitDirectory, 'usr', 'bin', 'ssh-keygen.exe') : 'ssh-keygen';
const source = fileURLToPath(new URL('../scripts/ssh-key-fingerprint.sh', import.meta.url));

function run(key) {
  const script = fs.readFileSync(source, 'utf8');
  const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: process.platform === 'win32' ? 30_000 : 10_000,
    windowsHide: true, env: { ...process.env, SSH_PRIVATE_KEY: key } });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}

for (const passphrase of ['', 'synthetic-passphrase-only']) {
  test(`deployment fingerprint is correct and secret-free for ${passphrase ? 'encrypted' : 'unencrypted'} existing keys`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cashaba-key-fingerprint-'));
    try {
      const file = path.join(temporary, 'fixture-key');
      const generated = spawnSync(keygen, ['-q', '-t', 'ed25519', '-f', file, '-N', passphrase,
        '-C', 'synthetic-comment-not-for-logs'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      assert.equal(generated.error, undefined);
      assert.equal(generated.status, 0, generated.stderr);
      const publicKey = fs.readFileSync(file + '.pub', 'utf8');
      const expected = spawnSync(keygen, ['-l', '-E', 'sha256', '-f', file + '.pub'],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      assert.equal(expected.status, 0, expected.stderr);
      const fingerprint = expected.stdout.trim().split(/\s+/)[1];
      const key = fs.readFileSync(file, 'utf8');
      const result = run(key);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.output.trim(), `::notice title=Deployment SSH key fingerprint::${fingerprint}`);
      assert.ok(!result.output.includes(key));
      assert.ok(!result.output.includes(publicKey.trim()));
      assert.ok(!result.output.includes('synthetic-comment-not-for-logs'));
      assert.ok(!result.output.includes('synthetic-passphrase-only'));
    } finally {
      const resolved = path.resolve(temporary);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('cashaba-key-fingerprint-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
}

test('missing or malformed deployment keys fail without exposing their input', () => {
  const missing = run('');
  assert.equal(missing.status, 1);
  assert.match(missing.output, /SSH_PRIVATE_KEY is missing/);
  const malformed = run('synthetic-invalid-private-input');
  assert.equal(malformed.status, 1);
  assert.match(malformed.output, /Cannot read the deployment key fingerprint/);
  assert.ok(!malformed.output.includes('synthetic-invalid-private-input'));
});
