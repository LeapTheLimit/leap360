import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';

export type Leap360Config = {
    apiKey: string;
    projectId: string;
    serviceName: string;
    baseUrl?: string;
};

type RunContext = {
    runId: string;
    agentName: string;
};

const runContextStorage = new AsyncLocalStorage<RunContext>();

export class Leap360 {
    private config: Required<Leap360Config>;
    private wrappedClient: any = null;

    constructor(config: Leap360Config) {
        this.config = {
            ...config,
            baseUrl: config.baseUrl || 'https://api.leap360.ai',
        };
    }

    wrapOpenAI<OpenAIClient extends any>(client: OpenAIClient): OpenAIClient {
        const originalCreate = (client as any).chat.completions.create;

        (client as any).chat.completions.create = async (body: any, options?: any) => {
            const startTime = Date.now();
            const runCtx = runContextStorage.getStore();

            let response: any;
            let error: any = null;

            try {
                response = await originalCreate.call((client as any).chat.completions, body, options);
            } catch (err) {
                error = err;
                throw err;
            } finally {
                const latencyMs = Date.now() - startTime;

                let model = body?.model || 'unknown';
                let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

                if (response) {
                    model = response.model || body?.model || 'unknown';
                    if (response.usage) {
                        usage = {
                            prompt_tokens: response.usage.prompt_tokens || 0,
                            completion_tokens: response.usage.completion_tokens || 0,
                            total_tokens: response.usage.total_tokens || 0,
                        };
                    }
                }

                const payload = {
                    project_id: this.config.projectId,
                    service_name: this.config.serviceName,
                    agent_name: runCtx?.agentName || null,
                    run_id: runCtx?.runId || crypto.randomUUID(),
                    provider: 'openai',
                    model,
                    request: typeof body === 'object' ? body : { content: body },
                    response: response || null,
                    latency_ms: latencyMs,
                    usage,
                    timestamp: new Date(startTime).toISOString(),
                    error: error ? (error instanceof Error ? error.message : String(error)) : null,
                };

                this.sendTrace(payload);
            }
            return response;
        };

        this.wrappedClient = client;
        return client;
    }

    private sendTrace(payload: any) {
        const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/traces`;

        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-leap360-key': this.config.apiKey,
            },
            body: JSON.stringify(payload),
        }).catch(err => {
            console.error('[Leap360] Error sending trace event:', err.message);
        });
    }

    createAgent(opts: { name: string }) {
        return {
            run: async <T>(fn: (client: any) => Promise<T>): Promise<T> => {
                const runId = crypto.randomUUID();
                return runContextStorage.run({ runId, agentName: opts.name }, async () => {
                    return fn(this.wrappedClient);
                });
            }
        };
    }
}
