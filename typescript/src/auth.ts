/**
 * leap360-sdk — auth helpers
 * Implements the Device Authorization Grant flow for CLI login.
 */

import { CLOUD_API_URL, CREDENTIALS_PATH, type Credentials } from './config.js';

// ─── Device Auth ──────────────────────────────────────────────────────────

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
}

export interface PollResponse {
  status: 'pending' | 'approved' | 'expired';
  apiKey?: string;
  userId?: string;
  email?: string;
}

/** Step 1: Ask the cloud API to create a device auth session */
export async function startDeviceAuth(): Promise<DeviceAuthResponse> {
  const res = await fetch(`${CLOUD_API_URL}/v1/auth/device/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to start device auth: ${res.status} — ${err}`);
  }

  return res.json() as Promise<DeviceAuthResponse>;
}

/** Step 3: Poll until the user approves or the session expires */
export async function pollForApproval(
  deviceCode: string,
  intervalMs = 3000,
  timeoutMs  = 600_000
): Promise<PollResponse> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const res = await fetch(`${CLOUD_API_URL}/v1/auth/device/poll?deviceCode=${encodeURIComponent(deviceCode)}`);
    if (!res.ok) continue;

    const data = (await res.json()) as PollResponse;
    if (data.status !== 'pending') return data;
  }

  return { status: 'expired' };
}

// ─── Credentials ─────────────────────────────────────────────────────────

/** Checks if running in a Node.js environment with access to 'fs' and 'path' */
function isNode(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

/** Save credentials to ~/.leap360/config.json */
export async function saveCredentials(creds: Omit<Credentials, 'savedAt'>): Promise<void> {
  if (!isNode()) return;

  try {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const full: Credentials = { ...creds, savedAt: new Date().toISOString() };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(full, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn('[Leap360] Failed to save credentials locally:', err);
  }
}

/** Load credentials from ~/.leap360/config.json, or null if not found */
export function loadCredentials(): Credentials | null {
  if (!isNode()) return null;

  try {
    // We use a dynamic require or check if we can use sync fs
    // Since this is a library, we should be careful with ESM/CJS compatibility
    // For now, we'll try a dynamic import or just use the global require if it exists
    const fs = require('fs');
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      return JSON.parse(data) as Credentials;
    }
  } catch (err) {
    // If require fails (e.g. in ESM without a shimming layer), we might need another approach
    // but typically Node environments will have it.
  }
  return null;
}

/** Delete saved credentials */
export async function clearCredentials(): Promise<void> {
  if (!isNode()) return;

  try {
    const fs = await import('fs');
    if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
  } catch (err) {
    console.warn('[Leap360] Failed to clear credentials:', err);
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
