'use strict';

// Loaded via `node --require` before anything else, so http/pg/amqplib/express
// get patched before the app imports them.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_SERVICE_NAMESPACE,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} = require('@opentelemetry/semantic-conventions');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

if (process.env.OTEL_DIAG_LOG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const serviceName = process.env.OTEL_SERVICE_NAME || 'unknown-service';
const serviceVersion = process.env.SERVICE_VERSION || '1.0.0';
const environment = process.env.DEPLOYMENT_ENVIRONMENT || 'local';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318';

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: serviceVersion,
  [ATTR_SERVICE_NAMESPACE]: 'observability-poc',
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
});

const traceExporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({
    url: `${otlpEndpoint}/v1/metrics`,
  }),
  exportIntervalMillis: 5000,
});

// instrumentation-pino forwards every pino log call here automatically once
// a LoggerProvider is registered - no extra wiring needed in logger.js.
const logRecordProcessor = new BatchLogRecordProcessor({
  exporter: new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` }),
});

const sdk = new NodeSDK({
  resource,
  // Skip auto host/process detection - it tagged every span with ~10 extra
  // fields and was what OOM'd Zipkin under load. Also kept process.pid out
  // of Prometheus labels, which was creating a new series on every restart.
  resourceDetectors: [],
  traceExporter,
  metricReader,
  logRecordProcessors: [logRecordProcessor],
  instrumentations: [
    getNodeAutoInstrumentations({
      // Noisy / not useful for this POC
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/metrics',
      },
    }),
  ],
});

sdk.start();

// eslint-disable-next-line no-console
console.log(`[otel] tracing initialized for "${serviceName}" -> ${otlpEndpoint}`);

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .catch((err) => console.error('[otel] error shutting down SDK', err))
    .finally(() => process.exit(0));
});
