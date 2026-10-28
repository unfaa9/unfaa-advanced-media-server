import http from 'http';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const counter = (name: string, help: string, labelNames: string[] = []) =>
  new client.Counter({ name, help, labelNames, registers: [registry] });
const gauge = (name: string, help: string, labelNames: string[] = []) =>
  new client.Gauge({ name, help, labelNames, registers: [registry] });

export const metrics = {
  httpRequests: counter('http_requests_total', 'HTTP requests', [
    'route',
    'method',
    'status',
  ]),
  httpDuration: new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
  uploads: counter('media_uploads_total', 'Uploads', ['kind', 'result']),
  uploadBytes: counter('media_upload_bytes_total', 'Uploaded bytes (as received)'),
  compressionSaved: counter(
    'media_compression_saved_bytes_total',
    'Bytes saved by image compression'
  ),
  variantGenerations: counter(
    'media_variant_generations_total',
    'Image variants rendered',
    ['fmt']
  ),
  variantDuration: new client.Histogram({
    name: 'media_variant_duration_seconds',
    help: 'Variant render time',
    buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  }),
  diskFree: gauge('media_disk_free_bytes', 'Free bytes on the storage volume'),
  filesTotal: gauge('media_files_total', 'Files by status', ['status']),
  jobs: counter('media_jobs_total', 'Background job runs', ['job', 'result']),
  jobsPending: gauge('media_jobs_pending', 'Queued CDN purge jobs'),
  jobsDead: gauge('media_jobs_dead', 'CDN purge jobs that gave up'),
  missingFiles: gauge(
    'media_missing_files',
    'Live files whose bytes are missing on disk'
  ),
  quotaDrift: gauge(
    'media_quota_drift_bytes',
    'Account usage drift corrected by the last reconcile'
  ),
};

// Served on its own port (METRICS_PORT); do not expose it through the reverse proxy.
export const startMetricsServer = (port: number): http.Server =>
  http
    .createServer(async (req, res) => {
      if (req.url !== '/metrics') {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    })
    .listen(port, '127.0.0.1');
