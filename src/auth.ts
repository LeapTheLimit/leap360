/**
 * leap360-sdk — auth helpers
 * Implements the Device Authorization Grant flow for CLI login.
 *
 * Flow:
 *  1. startDeviceAuth()   → get deviceCode + verificationUrl from cloud API
 *  2. (CLI opens browser with verificationUrl)
 *  3. pollForApproval()   → poll cloud API until user approves in browser
 *  4. saveCredentials()   → write apiKey to ~/.leap360/config.json
 */

import * as fs from 'fs';
import * as path from 'path';
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

/** Save credentials to ~/.leap360/config.json */
export function saveCredentials(creds: Omit<Credentials, 'savedAt'>): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const full: Credentials = { ...creds, savedAt: new Date().toISOString() };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(full, null, 2), { mode: 0o600 });
}

/** Load credentials from ~/.leap360/config.json, or null if not found */
export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    const raw  = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const data = JSON.parse(raw) as Credentials;
    if (!data.apiKey || !data.userId) return null;
    return data;
  } catch {
    return null;
  }
}

/** Delete saved credentials */
export function clearCredentials(): void {
  if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
}

// ─── Utility ─────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
