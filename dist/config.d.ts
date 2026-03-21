/**
 * leap360-sdk — shared config
 *
 * The CLOUD_API_URL will be updated after your first `sam deploy` run.
 * You can also override it via the LEAP360_API_URL environment variable.
 */
/** The deployed Cloud API URL — override with LEAP360_API_URL env var if needed */
export declare const CLOUD_API_URL: string;
/** Path to the local credentials file */
export declare const CREDENTIALS_PATH: string;
export interface Credentials {
    apiKey: string;
    userId: string;
    email: string;
    savedAt: string;
}
//# sourceMappingURL=config.d.ts.map