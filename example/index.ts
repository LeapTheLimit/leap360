import 'dotenv/config';
import { OpenAI } from 'openai';
import { Leap360 } from '@leap360/sdk';

// 1. Initialize Leap360
const leap = new Leap360({
    apiKey: process.env.LEAP360_API_KEY || 'leap360-dev-secret-key-change-me',
    projectId: process.env.SEED_PROJECT_ID || '00000000-0000-0000-0000-000000000001',
    serviceName: 'example-backend-service',
    baseUrl: 'http://localhost:4000',
});

// 2. Initialize and wrap OpenAI
const baseOpenAI = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'sk-fake-key-for-testing',
});

const openai = leap.wrapOpenAI(baseOpenAI);

// Create an agent context (optional, but good for grouping traces)
const customerSupportAgent = leap.createAgent({ name: 'CustomerSupportBot' });

async function runDemo() {
    console.log('Sending first trace (direct call)...');

    try {
        // This trace won't have an agent_name
        await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'Say hello world!' }],
        });
        console.log('✅ First trace sent.');
    } catch (e: any) {
        console.log('Expected error since we use a fake key, but trace should still be recorded!', e.message);
    }

    // Wait a bit
    await new Promise(r => setTimeout(r, 1000));

    const prompts = [
        "How do I track a package?",
        "What is your return policy?",
        "Can I change my shipping address?",
        "I need help with a refund.",
        "Where is my order #12345?"
    ];

    console.log('\nSending a batch of customer support traces...');
    for (const text of prompts) {
        await customerSupportAgent.run(async (client) => {
            try {
                console.log(`> Sending: ${text}`);
                await client.chat.completions.create({
                    model: 'gpt-4',
                    messages: [
                        { role: 'system', content: 'You are a helpful customer support assistant for Leap360 Store.' },
                        { role: 'user', content: text }
                    ],
                });
            } catch (e: any) {
                // We expect failure because of fake key, but SDK logs the trace regardless!
            }
        });
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\nDemo complete. Check the dashboard at http://localhost:5173 to see the traces!');
}

runDemo();
