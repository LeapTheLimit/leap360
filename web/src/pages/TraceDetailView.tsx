import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchTraceDetail } from '../api';
import { format } from 'date-fns';
import { ArrowLeft, Database, Clock, Server, Fingerprint } from 'lucide-react';

export function TraceDetailView() {
    const { traceId } = useParams();
    const [trace, setTrace] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!traceId) return;
        setLoading(true);
        fetchTraceDetail(traceId).then(data => {
            setTrace(data.data || data);
            setLoading(false);
        }).catch(err => {
            console.error(err);
            setLoading(false);
        });
    }, [traceId]);

    if (loading) return <div className="p-8 text-center text-gray-500">Loading trace details...</div>;
    if (!trace) return <div className="p-8 text-center text-red-500">Trace not found.</div>;

    return (
        <div className="space-y-6">
            <div className="flex items-center space-x-4">
                <Link to={`/services/${trace.serviceId || trace.service_id}/traces`} className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors">
                    <ArrowLeft className="h-5 w-5 text-gray-500" />
                </Link>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Trace Detail</h2>
                    <p className="text-sm text-gray-500">{trace.id}</p>
                </div>
            </div>

            <div className="grid gap-6 md:grid-cols-4">
                {/* Metadata Sidebar */}
                <div className="md:col-span-1 space-y-4">
                    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 p-5 shadow-sm space-y-4">
                        <div>
                            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Time</p>
                            <p className="text-sm text-gray-900 dark:text-gray-100">{format(new Date(trace.timestamp), 'PPpp')}</p>
                        </div>
                        <div>
                            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Provider & Model</p>
                            <p className="text-sm text-gray-900 dark:text-gray-100 flex items-center">
                                <Database className="w-4 h-4 mr-1.5 text-gray-400" />
                                {trace.provider} &middot; {trace.model}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Latency</p>
                            <p className="text-sm text-gray-900 dark:text-gray-100 flex items-center">
                                <Clock className="w-4 h-4 mr-1.5 text-gray-400" />
                                {trace.latencyMs || trace.latency_ms} ms
                            </p>
                        </div>
                        <div>
                            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Tokens Usage</p>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                <div className="bg-gray-50 dark:bg-zinc-950 p-2 rounded">
                                    <p className="text-gray-500 text-xs">Prompt</p>
                                    <p className="font-medium">{trace.promptTokens || trace.prompt_tokens || 0}</p>
                                </div>
                                <div className="bg-gray-50 dark:bg-zinc-950 p-2 rounded">
                                    <p className="text-gray-500 text-xs">Completion</p>
                                    <p className="font-medium">{trace.completionTokens || trace.completion_tokens || 0}</p>
                                </div>
                                <div className="col-span-2 bg-gray-50 dark:bg-zinc-950 p-2 rounded">
                                    <p className="text-gray-500 text-xs">Total</p>
                                    <p className="font-medium">{trace.totalTokens || trace.total_tokens || 0}</p>
                                </div>
                            </div>
                        </div>
                        {trace.agentName || trace.agent_name ? (
                            <div>
                                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Agent / Run context</p>
                                <div className="text-sm text-gray-900 dark:text-gray-100 break-all space-y-1">
                                    <span className="flex items-center text-blue-600 dark:text-blue-400">
                                        <Server className="w-4 h-4 mr-1.5" />
                                        {trace.agentName || trace.agent_name}
                                    </span>
                                    <span className="flex items-center text-gray-500 text-xs">
                                        <Fingerprint className="w-3.5 h-3.5 mr-1.5" />
                                        {trace.runId || trace.run_id}
                                    </span>
                                </div>
                            </div>
                        ) : null}
                    </div>

                    {trace.error && (
                        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-5 shadow-sm">
                            <p className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2">Error</p>
                            <p className="text-sm text-red-500 break-words">{trace.error}</p>
                        </div>
                    )}
                </div>

                {/* JSON Payloads */}
                <div className="md:col-span-3 space-y-6">
                    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm overflow-hidden">
                        <div className="bg-gray-50 dark:bg-zinc-950 px-4 py-3 border-b border-gray-200 dark:border-zinc-800">
                            <h3 className="font-medium text-gray-900 dark:text-gray-100">Request JSON</h3>
                        </div>
                        <div className="p-4 overflow-x-auto text-sm">
                            <pre className="text-gray-800 dark:text-gray-300 font-mono">
                                {JSON.stringify(trace.requestJson || trace.request_json, null, 2)}
                            </pre>
                        </div>
                    </div>

                    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm overflow-hidden">
                        <div className="bg-gray-50 dark:bg-zinc-950 px-4 py-3 border-b border-gray-200 dark:border-zinc-800">
                            <h3 className="font-medium text-gray-900 dark:text-gray-100">Response JSON</h3>
                        </div>
                        <div className="p-4 overflow-x-auto text-sm">
                            <pre className="text-gray-800 dark:text-gray-300 font-mono">
                                {JSON.stringify(trace.responseJson || trace.response_json, null, 2)}
                            </pre>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
