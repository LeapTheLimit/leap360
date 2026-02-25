import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchTraces } from '../api';
import { format } from 'date-fns';
import { ArrowLeft, Clock, Zap, AlertCircle } from 'lucide-react';

export function TracesView() {
    const { serviceId } = useParams();
    const [traces, setTraces] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [agentFilter, setAgentFilter] = useState('');

    useEffect(() => {
        if (!serviceId) return;
        setLoading(true);
        fetchTraces(serviceId, agentFilter).then(data => {
            setTraces(Array.isArray(data) ? data : data.data || []);
            setLoading(false);
        }).catch(err => {
            console.error(err);
            setLoading(false);
        });
    }, [serviceId, agentFilter]);

    // Extract unique agents for the filter
    const uniqueAgents = Array.from(new Set(traces.map(t => t.agentName || t.agent_name).filter(Boolean)));

    return (
        <div className="space-y-6">
            <div className="flex items-center space-x-4">
                <Link to="/services" className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors">
                    <ArrowLeft className="h-5 w-5 text-gray-500" />
                </Link>
                <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Traces</h2>
            </div>

            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm overflow-hidden">
                <div className="p-4 border-b border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-900/50 flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Filter by Agent:</label>
                        <select
                            value={agentFilter}
                            onChange={(e) => setAgentFilter(e.target.value)}
                            className="bg-white dark:bg-zinc-950 border border-gray-300 dark:border-zinc-700 text-gray-900 dark:text-gray-100 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2"
                        >
                            <option value="">All Agents</option>
                            {uniqueAgents.map(ag => (
                                <option key={ag as string} value={ag as string}>{ag as string}</option>
                            ))}
                        </select>
                    </div>
                    <div className="text-sm text-gray-500">
                        {traces.length} trace(s)
                    </div>
                </div>

                {loading ? (
                    <div className="p-8 text-center text-gray-500">Loading traces...</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left text-gray-600 dark:text-gray-400 bg-white dark:bg-zinc-950">
                            <thead className="text-xs text-gray-700 dark:text-gray-300 uppercase bg-gray-50 dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800">
                                <tr>
                                    <th className="px-6 py-3">Time</th>
                                    <th className="px-6 py-3">Agent Name</th>
                                    <th className="px-6 py-3">Model</th>
                                    <th className="px-6 py-3">Latency</th>
                                    <th className="px-6 py-3">Tokens</th>
                                    <th className="px-6 py-3 text-right">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {traces.map((trace) => (
                                    <tr key={trace.id} className="border-b dark:border-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                                        <td className="px-6 py-4 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                                            <Link to={`/traces/${trace.id}`} className="hover:underline flex flex-col">
                                                <span>{format(new Date(trace.timestamp), 'MMM d, HH:mm:ss')}</span>
                                                <span className="text-xs text-gray-400">{trace.id.substring(0, 8)}...</span>
                                            </Link>
                                        </td>
                                        <td className="px-6 py-4">
                                            {trace.agentName || trace.agent_name ? (
                                                <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs font-medium px-2.5 py-0.5 rounded border border-blue-200 dark:border-blue-800">
                                                    {trace.agentName || trace.agent_name}
                                                </span>
                                            ) : '-'}
                                        </td>
                                        <td className="px-6 py-4 font-mono text-xs">{trace.model}</td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center">
                                                <Clock className="w-3.5 h-3.5 mr-1 text-gray-400" />
                                                {trace.latencyMs || trace.latency_ms}ms
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center">
                                                <Zap className="w-3.5 h-3.5 mr-1 text-yellow-500" />
                                                {trace.totalTokens || trace.total_tokens || 0}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            {trace.error ? (
                                                <span className="inline-flex items-center text-red-600 dark:text-red-400">
                                                    <AlertCircle className="w-4 h-4 mr-1" /> Error
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center text-green-600 dark:text-green-500">
                                                    OK
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                                {traces.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                                            No traces found for this selection.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
