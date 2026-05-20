/**
 * leap360 — local auth helpers
 *
 * All auth is local-only: credentials are read/written to
 * ~/.leap360/config.json.  No cloud device-flow, no Cognito.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Paths ────────────────────────────────────────────────────────────────────

export const CONFIG_DIR  = path.join(os.homedir(), '.leap360');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Credentials {
  apiKey:      string;
  projectId:   string;
  serviceName: string;
  baseUrl:     string;
  savedAt?:    string;
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/** Save credentials to ~/.leap360/config.json (mode 600) */
export function saveCredentials(creds: Omit<Credentials, 'savedAt'>): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const full: Credentials = { ...creds, savedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(full, null, 2), { mode: 0o600 });
}

/** Load credentials from ~/.leap360/config.json, or null if not found */
export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw  = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw) as Credentials;
    if (!data.apiKey) return null;
    return data;
  } catch {
    return null;
  }
}

/** Delete saved credentials */
export function clearCredentials(): void {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
}
