/**
 * leap360-sdk — shared config
 *
 * The CLOUD_API_URL will be updated after your first `sam deploy` run.
 * You can also override it via the LEAP360_API_URL environment variable.
 */

import * as os from 'os';
import * as path from 'path';

/** The deployed Cloud API URL — override with LEAP360_API_URL env var if needed */
export const CLOUD_API_URL = process.env['LEAP360_API_URL'] || 'https://b0vyk178b7.execute-api.us-east-1.amazonaws.com';

/** Path to the local credentials file */
export const CREDENTIALS_PATH = path.join(os.homedir(), '.leap360', 'config.json');

export interface Credentials {
  apiKey: string;
  userId: string;
  email: string;
  savedAt: string;
}
