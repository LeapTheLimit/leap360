/**
 * leap360-sdk — shared config
 *
 * The CLOUD_API_URL will be updated after your first `sam deploy` run.
 * You can also override it via the LEAP360_API_URL environment variable.
 */

/** The deployed Cloud API URL — override with LEAP360_API_URL env var if needed */
export const CLOUD_API_URL = (typeof process !== 'undefined' && process.env['LEAP360_API_URL']) || 'https://9ol8if3g4e.execute-api.us-east-1.amazonaws.com';

/** Path to the local credentials file - resolved at runtime for cross-platform support */
export const getCredentialsPath = (): string => {
  if (typeof process === 'undefined') return '/.leap360/config.json';
  const homedir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return `${homedir}/.leap360/config.json`;
};
export const CREDENTIALS_PATH = getCredentialsPath();

export interface Credentials {
  apiKey: string;
  userId: string;
  projectId?: string;
  serviceName?: string;
  savedAt: string;
}
