'use strict';

const amqplib = require('amqplib');
const { logger } = require('./logger');

const EXCHANGE = process.env.EVENTS_EXCHANGE || 'events';
const url = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

let connection;
let channel;

async function connectWithRetry(retries = 20, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      connection = await amqplib.connect(url);
      channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

      connection.on('error', (err) => logger.error({ err }, '[rabbitmq] connection error'));
      connection.on('close', () => logger.warn('[rabbitmq] connection closed'));

      logger.info({ url, exchange: EXCHANGE }, '[rabbitmq] connected');
      return channel;
    } catch (err) {
      logger.warn(
        { attempt, retries, err: err.message },
        '[rabbitmq] connection failed, retrying...'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('[rabbitmq] could not connect after max retries');
}

async function publish(routingKey, payload, options = {}) {
  if (!channel) throw new Error('[rabbitmq] channel not initialized, call connectWithRetry first');
  const buffer = Buffer.from(JSON.stringify(payload));
  channel.publish(EXCHANGE, routingKey, buffer, {
    contentType: 'application/json',
    persistent: true,
    ...options,
  });
  logger.info({ routingKey, payload }, '[rabbitmq] published event');
}

async function consume(queueName, routingKeys, handler, { prefetch = 5 } = {}) {
  if (!channel) throw new Error('[rabbitmq] channel not initialized, call connectWithRetry first');
  await channel.assertQueue(queueName, { durable: true });
  await Promise.all(
    routingKeys.map((key) => channel.bindQueue(queueName, EXCHANGE, key))
  );
  await channel.prefetch(prefetch);

  channel.consume(queueName, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload, msg);
      channel.ack(msg);
    } catch (err) {
      logger.error({ err }, '[rabbitmq] handler failed, nacking message');
      channel.nack(msg, false, false);
    }
  });

  logger.info({ queueName, routingKeys }, '[rabbitmq] consumer registered');
}

module.exports = { connectWithRetry, publish, consume, EXCHANGE };
