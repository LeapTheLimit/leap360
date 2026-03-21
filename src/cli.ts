#!/usr/bin/env node
/**
 * leap360-sdk — CLI entry point
 *
 * Commands:
 *   leap360 login    — authenticate via your Leap360 dashboard (browser-based)
 *   leap360 logout   — remove saved credentials
 *   leap360 status   — show current login status
 *   leap360 --version
 */

import { Command } from 'commander';
import { startDeviceAuth, pollForApproval, saveCredentials, loadCredentials, clearCredentials } from './auth.js';

const program = new Command();

program
  .name('leap360')
  .description('Leap360 AI Governance SDK CLI')
  .version('1.0.0');

// ─── Command: login ────────────────────────────────────────────────────────
program
  .command('login')
  .description('Log in to Leap360 and save your API key locally')
  .action(async () => {
    console.log('\n🔐  Leap360 Login\n');

    // 1. Start device auth session
    let session;
    try {
      session = await startDeviceAuth();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌  Could not reach the Leap360 cloud API.\n   ${msg}`);
      console.error('\n   Make sure LEAP360_API_URL is set (see README).\n');
      process.exit(1);
    }

    // 2. Show user code & open browser
    console.log(`   Opening your browser to:\n`);
    console.log(`   ${session.verificationUrl}\n`);
    console.log(`   Your verification code: \x1b[1;33m${session.userCode}\x1b[0m`);
    console.log('\n   (Waiting for you to approve in the browser…)\n');

    // Dynamically import `open` (ESM package)
    try {
      const open = (await import('open')).default;
      await open(session.verificationUrl);
    } catch {
      console.log('   [Could not open browser automatically — please paste the URL above manually]\n');
    }

    // 3. Poll for approval
    const result = await pollForApproval(session.deviceCode);

    if (result.status === 'approved' && result.apiKey) {
      saveCredentials({
        apiKey: result.apiKey,
        userId: result.userId!,
        email:  result.email!,
      });
      console.log(`✅  Logged in as \x1b[1;32m${result.email}\x1b[0m`);
      console.log(`   API key saved to ~/.leap360/config.json\n`);
      console.log('   You can now use the SDK in your AI application:\n');
      console.log('   \x1b[36mimport { Leap360Client } from \'leap360-sdk\';\x1b[0m');
      console.log('   \x1b[36mconst leap = new Leap360Client();\x1b[0m\n');
    } else if (result.status === 'expired') {
      console.error('❌  Login timed out (10 minutes). Run `leap360 login` again.\n');
      process.exit(1);
    } else {
      console.error('❌  Login was not approved. Try again.\n');
      process.exit(1);
    }
  });

// ─── Command: logout ───────────────────────────────────────────────────────
program
  .command('logout')
  .description('Remove saved Leap360 credentials from this machine')
  .action(() => {
    const creds = loadCredentials();
    if (!creds) {
      console.log('\n⚠️  You are not logged in.\n');
      return;
    }
    clearCredentials();
    console.log(`\n✅  Logged out (removed credentials for ${creds.email}).\n`);
  });

// ─── Command: status ───────────────────────────────────────────────────────
program
  .command('status')
  .description('Show your current Leap360 login status')
  .action(() => {
    const creds = loadCredentials();
    if (!creds) {
      console.log('\n⚠️  Not logged in.  Run: \x1b[36mleap360 login\x1b[0m\n');
      return;
    }
    console.log('\n✅  Logged in to Leap360\n');
    console.log(`   Email:   ${creds.email}`);
    console.log(`   User ID: ${creds.userId}`);
    console.log(`   API Key: ${creds.apiKey.substring(0, 16)}…`);
    console.log(`   Saved:   ${creds.savedAt}\n`);
  });

program.parse(process.argv);
