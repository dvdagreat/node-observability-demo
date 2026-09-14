'use strict';

const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');

const { pool } = require('./db');
const { logger } = require('./logger');
const { meter } = require('./metrics');
const rabbitmq = require('./rabbitmq');

const PORT = process.env.PORT || 3001;

const reservationsCounter = meter.createCounter('inventory_reservations_total', {
  description: 'Number of inventory reservation attempts, by result',
});
const reservationDuration = meter.createHistogram('inventory_reservation_duration_seconds', {
  description: 'Time taken to process a reservation attempt for one order',
  unit: 's',
});

meter
  .createObservableGauge('inventory_stock_level', {
    description: 'Current available quantity per product',
  })
  .addCallback(async (observableResult) => {
    try {
      const { rows } = await pool.query('SELECT product_id, quantity_available FROM inventory');
      for (const row of rows) {
        observableResult.observe(row.quantity_available, { product_id: row.product_id });
      }
    } catch (err) {
      logger.error({ err }, 'failed to collect inventory_stock_level');
    }
  });

const app = express();
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'inventory-service' }));

app.get('/inventory', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT product_id, product_name, quantity_available, updated_at FROM inventory ORDER BY product_id'
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

async function reserveStock(orderId, items) {
  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query('BEGIN');

    for (const item of items) {
      const { rows } = await client.query(
        'SELECT quantity_available FROM inventory WHERE product_id = $1 FOR UPDATE',
        [item.productId]
      );

      if (rows.length === 0) {
        throw new InsufficientStockError(`unknown product ${item.productId}`);
      }
      if (rows[0].quantity_available < item.quantity) {
        throw new InsufficientStockError(
          `insufficient stock for ${item.productId}: requested ${item.quantity}, available ${rows[0].quantity_available}`
        );
      }
    }

    for (const item of items) {
      await client.query(
        'UPDATE inventory SET quantity_available = quantity_available - $2, updated_at = now() WHERE product_id = $1',
        [item.productId, item.quantity]
      );
    }

    await client.query(
      'INSERT INTO reservations (order_id, status) VALUES ($1, $2)',
      [orderId, 'RESERVED']
    );

    await client.query('COMMIT');
    reservationsCounter.add(1, { result: 'reserved' });
    return { status: 'RESERVED' };
  } catch (err) {
    await client.query('ROLLBACK');
    const reason = err instanceof InsufficientStockError ? err.message : 'internal error';
    await pool.query('INSERT INTO reservations (order_id, status, reason) VALUES ($1, $2, $3)', [
      orderId,
      'FAILED',
      reason,
    ]);
    reservationsCounter.add(1, { result: 'failed' });
    return { status: 'FAILED', reason };
  } finally {
    client.release();
    reservationDuration.record((Date.now() - start) / 1000);
  }
}

class InsufficientStockError extends Error {}

async function main() {
  await rabbitmq.connectWithRetry();

  await rabbitmq.consume('inventory-service.order-events', ['order.created'], async (event) => {
    const { orderId, items } = event;
    logger.info({ orderId }, 'processing order for inventory reservation');

    const result = await reserveStock(orderId, items);

    if (result.status === 'RESERVED') {
      await rabbitmq.publish('inventory.reserved', { orderId, status: 'RESERVED' });
    } else {
      await rabbitmq.publish('inventory.failed', {
        orderId,
        status: 'FAILED',
        reason: result.reason,
      });
    }
  });

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'inventory-service listening');
  });
}

main().catch((err) => {
  logger.error({ err }, 'inventory-service failed to start');
  process.exit(1);
});
