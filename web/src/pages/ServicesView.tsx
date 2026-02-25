import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchServices } from '../api';
import { formatDistanceToNow } from 'date-fns';
import { Server, Clock, Activity } from 'lucide-react';

export function ServicesView() {
    const [services, setServices] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchServices().then(data => {
            // The API might return { data: [...] } or just [...]
            setServices(Array.isArray(data) ? data : data.data || []);
            setLoading(false);
        }).catch(err => {
            console.error(err);
            setLoading(false);
        });
    }, []);

    if (loading) return <div className="p-8 text-center text-gray-500">Loading services...</div>;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Services</h2>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {services.map((svc: any) => (
                    <Link key={svc.id} to={`/services/${svc.id}/traces`} className="block group">
                        <div className="p-6 bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 shadow-sm hover:border-blue-500 dark:hover:border-blue-400 transition-colors">
                            <div className="flex items-center space-x-3 mb-4">
                                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
                                    <Server className="h-5 w-5" />
                                </div>
                                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                                    {svc.name}
                                </h3>
                            </div>

                            <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                                <div className="flex items-center justify-between">
                                    <span className="flex items-center"><Clock className="h-4 w-4 mr-1.5" /> Last seen</span>
                                    <span>{formatDistanceToNow(new Date(svc.lastSeenAt || svc.last_seen_at), { addSuffix: true })}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="flex items-center"><Activity className="h-4 w-4 mr-1.5" /> Traces</span>
                                    <span className="font-medium text-gray-900 dark:text-gray-200">{svc._count?.traces || svc.traceCount || 0}</span>
                                </div>
                            </div>
                        </div>
                    </Link>
                ))}

                {services.length === 0 && (
                    <div className="col-span-full p-12 text-center border-2 border-dashed border-gray-200 dark:border-zinc-800 rounded-xl text-gray-500">
                        No services found. Integrate the SDK and send your first trace!
                    </div>
                )}
            </div>
        </div>
    );
}
