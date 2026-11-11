/**
 * Post-build script — makes dist/cli.js executable on Unix/Mac systems.
 * On Windows this is a no-op (npm handles it differently via .cmd wrappers).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

if (fs.existsSync(cliPath)) {
  try {
    let content = fs.readFileSync(cliPath, 'utf8');
    const shebang = '#!/usr/bin/env node\n';
    if (!content.startsWith(shebang)) {
       fs.writeFileSync(cliPath, shebang + content);
       console.log('✅  Injected node shebang');
    }
    fs.chmodSync(cliPath, 0o755);
    console.log('✅  Made dist/cli.js executable');
  } catch (e) {
    console.error('❌ Failed to update cli.js:', e.message);
  }
} else {
  console.warn('⚠️  dist/cli.js not found — did the build succeed?');
}
