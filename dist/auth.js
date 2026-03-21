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
import { CLOUD_API_URL, CREDENTIALS_PATH } from './config.js';
/** Step 1: Ask the cloud API to create a device auth session */
export async function startDeviceAuth() {
    const res = await fetch(`${CLOUD_API_URL}/v1/auth/device/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to start device auth: ${res.status} — ${err}`);
    }
    return res.json();
}
/** Step 3: Poll until the user approves or the session expires */
export async function pollForApproval(deviceCode, intervalMs = 3000, timeoutMs = 600_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        const res = await fetch(`${CLOUD_API_URL}/v1/auth/device/poll?deviceCode=${encodeURIComponent(deviceCode)}`);
        if (!res.ok)
            continue;
        const data = (await res.json());
        if (data.status !== 'pending')
            return data;
    }
    return { status: 'expired' };
}
// ─── Credentials ─────────────────────────────────────────────────────────
/** Save credentials to ~/.leap360/config.json */
export function saveCredentials(creds) {
    const dir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const full = { ...creds, savedAt: new Date().toISOString() };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(full, null, 2), { mode: 0o600 });
}
/** Load credentials from ~/.leap360/config.json, or null if not found */
export function loadCredentials() {
    try {
        if (!fs.existsSync(CREDENTIALS_PATH))
            return null;
        const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
        const data = JSON.parse(raw);
        if (!data.apiKey || !data.userId)
            return null;
        return data;
    }
    catch {
        return null;
    }
}
/** Delete saved credentials */
export function clearCredentials() {
    if (fs.existsSync(CREDENTIALS_PATH))
        fs.unlinkSync(CREDENTIALS_PATH);
}
// ─── Utility ─────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=auth.js.map