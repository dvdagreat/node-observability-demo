'use strict';

const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { v4: uuidv4 } = require('uuid');

const { pool } = require('./db');
const { logger } = require('./logger');
const { meter } = require('./metrics');
const rabbitmq = require('./rabbitmq');

const PORT = process.env.PORT || 3000;

const ordersCreatedCounter = meter.createCounter('orders_created_total', {
  description: 'Number of orders created',
});
const orderStatusUpdatesCounter = meter.createCounter('order_status_updates_total', {
  description: 'Number of order status transitions, by status',
});
const orderFulfillmentDuration = meter.createHistogram('order_fulfillment_duration_seconds', {
  description: 'Time from order creation to a terminal inventory decision',
  unit: 's',
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'order-service' }));

app.post('/orders', async (req, res, next) => {
  try {
    const { customerId, items } = req.body || {};

    if (!customerId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'customerId and non-empty items[] are required' });
    }
    for (const item of items) {
      if (!item.productId || !item.quantity || !item.unitPrice) {
        return res
          .status(400)
          .json({ error: 'each item requires productId, quantity, unitPrice' });
      }
    }

    const orderId = uuidv4();
    const totalAmount = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

    await pool.query(
      `INSERT INTO orders (id, customer_id, items, total_amount, status)
       VALUES ($1, $2, $3, $4, 'PENDING')`,
      [orderId, customerId, JSON.stringify(items), totalAmount]
    );

    ordersCreatedCounter.add(1, { customer_id: customerId });

    await rabbitmq.publish('order.created', {
      orderId,
      customerId,
      items,
      totalAmount,
      createdAt: new Date().toISOString(),
    });

    req.log.info({ orderId }, 'order created');
    res.status(201).json({ orderId, status: 'PENDING', totalAmount });
  } catch (err) {
    next(err);
  }
});

app.get('/orders', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const { rows } = await pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/orders/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'order not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal server error' });
});

async function updateOrderStatus(orderId, status, failureReason) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = $2, failure_reason = $3, updated_at = now()
     WHERE id = $1
     RETURNING created_at`,
    [orderId, status, failureReason || null]
  );
  orderStatusUpdatesCounter.add(1, { status });

  if (rows.length > 0) {
    const createdAt = new Date(rows[0].created_at).getTime();
    orderFulfillmentDuration.record((Date.now() - createdAt) / 1000, { status });
  }
}

async function main() {
  await rabbitmq.connectWithRetry();

  await rabbitmq.consume(
    'order-service.inventory-events',
    ['inventory.reserved', 'inventory.failed'],
    async (event) => {
      if (event.status === 'RESERVED') {
        await updateOrderStatus(event.orderId, 'INVENTORY_RESERVED');
      } else {
        await updateOrderStatus(event.orderId, 'INVENTORY_FAILED', event.reason);
      }
      logger.info({ orderId: event.orderId, status: event.status }, 'order status updated');
    }
  );

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'order-service listening');
  });
}

main().catch((err) => {
  logger.error({ err }, 'order-service failed to start');
  process.exit(1);
});
