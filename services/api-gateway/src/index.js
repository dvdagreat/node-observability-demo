'use strict';

const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { logger } = require('./logger');
const { meter } = require('./metrics');

const PORT = process.env.PORT || 8080;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3000';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3001';
const NOTIFICATION_SERVICE_URL =
  process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3002';

const gatewayRequestsCounter = meter.createCounter('gateway_requests_total', {
  description: 'Requests handled by the API gateway, by route and status',
});

const app = express();
app.use(cors());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

app.use((req, res, next) => {
  res.on('finish', () => {
    gatewayRequestsCounter.add(1, { route: req.baseUrl || req.path, status: String(res.statusCode) });
  });
  next();
});

// pathFilter, not app.use('/api/orders', ...) - Express strips the mount
// prefix before pathRewrite would ever see it.
app.use(
  createProxyMiddleware({
    pathFilter: '/api/orders',
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/orders': '/orders' },
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: '/api/inventory',
    target: INVENTORY_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/inventory': '/inventory' },
  })
);

app.use(
  createProxyMiddleware({
    pathFilter: '/api/notifications',
    target: NOTIFICATION_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/notifications': '/notifications' },
  })
);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'api-gateway listening');
});
