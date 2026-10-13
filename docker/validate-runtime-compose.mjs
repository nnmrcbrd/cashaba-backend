// Read Docker Compose's parsed configuration; never load or print env_file values.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertRuntimeCompose(config) {
  const app = config?.services?.app;
  if (!app || Object.keys(config.services).length !== 1) throw new Error('Deployment requires the app-only backend Compose configuration');
  if (Number(app.environment?.PORT) !== 8000) throw new Error('PORT inside the app container must be 8000 to match the image health check; host port is configured separately');
  if (!app.ports?.some(port => Number(port.target) === 8000 && Number(port.published) === 8001 && port.host_ip === '127.0.0.1')) {
    throw new Error('Forward VPS loopback port 8001 to the app container port 8000');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let config;
  try { config = JSON.parse(input); }
  catch { console.error('Invalid Compose configuration JSON'); process.exit(1); }
  try {
    assertRuntimeCompose(config);
    console.log('Backend Compose ports and image health-check contract are valid.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
