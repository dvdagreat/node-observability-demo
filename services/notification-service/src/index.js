'use strict';

const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const { pool } = require('./db');
const { logger } = require('./logger');
const { meter } = require('./metrics');
const rabbitmq = require('./rabbitmq');

const PORT = process.env.PORT || 3002;
const tracer = trace.getTracer('notification-service');

const notificationsCounter = meter.createCounter('notifications_sent_total', {
  description: 'Number of notifications processed, by type and outcome',
});
const providerLatency = meter.createHistogram('notification_provider_latency_seconds', {
  description: 'Simulated latency of the downstream notification provider call',
  unit: 's',
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'notification-service' }));

app.get('/notifications', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const { rows } = await pool.query(
      'SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal server error' });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake call to an email/SMS provider - random latency, occasional failure.
async function callNotificationProvider(orderId) {
  return tracer.startActiveSpan('notification-provider.send', async (span) => {
    const start = Date.now();
    try {
      const latencyMs = 80 + Math.random() * 320;
      await sleep(latencyMs);

      const shouldFail = Math.random() < 0.07;
      if (shouldFail) {
        throw new Error('provider timeout: no ack from downstream email gateway');
      }

      span.setAttribute('notification.order_id', orderId);
      span.setStatus({ code: SpanStatusCode.OK });
      return { ok: true };
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      return { ok: false, error: err.message };
    } finally {
      providerLatency.record((Date.now() - start) / 1000);
      span.end();
    }
  });
}

async function handleInventoryEvent(event) {
  const type = event.status === 'RESERVED' ? 'ORDER_CONFIRMED' : 'ORDER_FAILED';
  const message =
    event.status === 'RESERVED'
      ? `Your order ${event.orderId} has been confirmed and is being prepared.`
      : `Your order ${event.orderId} could not be fulfilled: ${event.reason || 'unknown reason'}.`;

  const result = await callNotificationProvider(event.orderId);
  const outcome = result.ok ? 'sent' : 'failed';

  await pool.query(
    'INSERT INTO notifications (order_id, channel, type, message) VALUES ($1, $2, $3, $4)',
    [event.orderId, 'EMAIL', outcome === 'sent' ? type : `${type}_DELIVERY_FAILED`, message]
  );

  notificationsCounter.add(1, { type, outcome });
  logger.info({ orderId: event.orderId, type, outcome }, 'notification processed');
}

async function main() {
  await rabbitmq.connectWithRetry();

  await rabbitmq.consume(
    'notification-service.inventory-events',
    ['inventory.reserved', 'inventory.failed'],
    handleInventoryEvent
  );

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'notification-service listening');
  });
}

main().catch((err) => {
  logger.error({ err }, 'notification-service failed to start');
  process.exit(1);
});
