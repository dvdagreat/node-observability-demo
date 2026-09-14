'use strict';

const { metrics } = require('@opentelemetry/api');

// Requires tracing.js to have run first (it registers the MeterProvider).
const meter = metrics.getMeter(process.env.OTEL_SERVICE_NAME || 'unknown-service');

module.exports = { meter };
