// Fixture for the scanner tests: an agent with tools of every risk level. Never executed.
import { tool } from 'ai';
import { z } from 'zod';
import { Leap360 } from 'leap360';
import Stripe from 'stripe';
import { removeNamespace } from './lib/k8s';
import * as ops from './lib/ops';

const leap = new Leap360({ apiKey: 'x', projectId: 'p', serviceName: 'fixture' });
const stripe = new Stripe('sk_test_fixture');

export const tools = {
  delete_namespace: tool({
    description: 'Delete a Kubernetes namespace',
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }: { name: string }) => removeNamespace(name),
  }),
  get_weather: tool({
    description: 'Current weather',
    parameters: z.object({ city: z.string() }),
    execute: async ({ city }: { city: string }) => (await fetch(`https://wttr.in/${city}`)).text(),
  }),
  refund: tool({
    description: 'Refund a charge',
    parameters: z.object({ charge: z.string() }),
    execute: leap.wrapTool('refund', async ({ charge }: { charge: string }) => stripe.refunds.create({ charge })),
  }),
  cleanup: tool({
    description: 'Clear caches',
    parameters: z.object({}),
    execute: async () => ops.wipeCache(),
  }),
};
