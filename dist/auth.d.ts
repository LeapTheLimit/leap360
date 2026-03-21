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
import { type Credentials } from './config.js';
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
export declare function startDeviceAuth(): Promise<DeviceAuthResponse>;
/** Step 3: Poll until the user approves or the session expires */
export declare function pollForApproval(deviceCode: string, intervalMs?: number, timeoutMs?: number): Promise<PollResponse>;
/** Save credentials to ~/.leap360/config.json */
export declare function saveCredentials(creds: Omit<Credentials, 'savedAt'>): void;
/** Load credentials from ~/.leap360/config.json, or null if not found */
export declare function loadCredentials(): Credentials | null;
/** Delete saved credentials */
export declare function clearCredentials(): void;
//# sourceMappingURL=auth.d.ts.map