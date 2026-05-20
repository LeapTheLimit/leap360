#!/usr/bin/env node
/**
 * leap360 CLI — local-only tooling
 *
 * Commands:
 *   leap360 setup   — interactive setup: save API key + project ID to ~/.leap360/config.json
 *   leap360 whoami  — print the saved config
 *   leap360 clear   — remove saved credentials
 *   leap360 --version
 */

import { Command } from 'commander';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.leap360');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface Config {
    apiKey: string;
    projectId: string;
    serviceName: string;
    baseUrl: string;
}

function loadConfig(): Config | null {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(raw) as Config;
    } catch {
        return null;
    }
}

function saveConfig(cfg: Config): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
    return new Promise(resolve => rl.question(prompt, resolve));
}

const program = new Command();

program
    .name('leap360')
    .description('Leap360 AI Governance — local SDK tooling')
    .version('1.0.0');

// ── setup ────────────────────────────────────────────────────────────────────
program
    .command('setup')
    .description('Configure your local Leap360 API key and project settings')
    .action(async () => {
        console.log('\n�  Leap360 Setup\n');
        console.log('   This saves your config to ~/.leap360/config.json');
        console.log('   Your API key is the value of LEAP360_API_KEY in your .env\n');

        const existing = loadConfig();

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const apiKey = await question(
            rl,
            `   API key [${existing?.apiKey ?? 'leap360-dev-secret-key-change-me'}]: `
        );
        const projectId = await question(
            rl,
            `   Project ID [${existing?.projectId ?? '00000000-0000-0000-0000-000000000001'}]: `
        );
        const serviceName = await question(
            rl,
            `   Service name [${existing?.serviceName ?? 'my-service'}]: `
        );
        const baseUrl = await question(
            rl,
            `   API base URL [${existing?.baseUrl ?? 'http://localhost:4000'}]: `
        );

        rl.close();

        const cfg: Config = {
            apiKey: apiKey.trim() || existing?.apiKey || 'leap360-dev-secret-key-change-me',
            projectId: projectId.trim() || existing?.projectId || '00000000-0000-0000-0000-000000000001',
            serviceName: serviceName.trim() || existing?.serviceName || 'my-service',
            baseUrl: baseUrl.trim() || existing?.baseUrl || 'http://localhost:4000',
        };

        saveConfig(cfg);

        console.log('\n✅  Config saved to', CONFIG_FILE);
        console.log(`   API Key:     ${cfg.apiKey}`);
        console.log(`   Project ID:  ${cfg.projectId}`);
        console.log(`   Service:     ${cfg.serviceName}`);
        console.log(`   Base URL:    ${cfg.baseUrl}`);
        console.log('\n   Start the server:  pnpm dev  (in the project root)\n');
    });

// ── whoami ───────────────────────────────────────────────────────────────────
program
    .command('whoami')
    .description('Show saved Leap360 configuration')
    .action(() => {
        const cfg = loadConfig();
        if (!cfg) {
            console.log('\n❌  No config found. Run: leap360 setup\n');
            process.exit(1);
        }
        console.log('\n📋  Leap360 config (~/.leap360/config.json):');
        console.log(`   API Key:    ${cfg.apiKey}`);
        console.log(`   Project ID: ${cfg.projectId}`);
        console.log(`   Service:    ${cfg.serviceName}`);
        console.log(`   Base URL:   ${cfg.baseUrl}\n`);
    });

// ── clear ────────────────────────────────────────────────────────────────────
program
    .command('clear')
    .description('Remove saved credentials')
    .action(() => {
        try {
            fs.unlinkSync(CONFIG_FILE);
            console.log('\n🗑️   Credentials cleared.\n');
        } catch {
            console.log('\nNo credentials found.\n');
        }
    });

program.parse();
