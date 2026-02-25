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

    console.log('\nSending second trace (via Agent context)...');
    await customerSupportAgent.run(async (client) => {
        try {
            await client.chat.completions.create({
                model: 'gpt-4',
                messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Help me reset my password.' }],
            });
            console.log('✅ Second trace sent.');
        } catch (e: any) {
            console.log('Expected error, trace recorded.', e.message);
        }
    });

    console.log('\nDemo complete. Check the dashboard at http://localhost:5173 to see the traces!');
}

runDemo();
