'use strict';

const axios = require('axios');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://api-gateway:8080';
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 400);
const MAX_INTERVAL_MS = Number(process.env.MAX_INTERVAL_MS || 1500);

// A couple of these are low/zero stock on purpose, to trigger failures too.
const PRODUCTS = [
  { productId: 'sku-widget', unitPrice: 9.99 },
  { productId: 'sku-gadget', unitPrice: 24.5 },
  { productId: 'sku-gizmo', unitPrice: 42.0 },
  { productId: 'sku-doohickey', unitPrice: 15.75 },
  { productId: 'sku-thingamajig', unitPrice: 60.0 },
];

const CUSTOMERS = ['cust-1001', 'cust-1002', 'cust-1003', 'cust-1004', 'cust-1005'];

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[randomInt(0, arr.length - 1)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildOrder() {
  const itemCount = randomInt(1, 3);
  const items = Array.from({ length: itemCount }, () => {
    const product = pick(PRODUCTS);
    return {
      productId: product.productId,
      unitPrice: product.unitPrice,
      quantity: randomInt(1, 4),
    };
  });

  return { customerId: pick(CUSTOMERS), items };
}

async function createOrder() {
  const order = buildOrder();
  try {
    const { data, status } = await axios.post(`${GATEWAY_URL}/api/orders`, order, {
      timeout: 5000,
    });
    console.log(`[load-generator] ${status} order ${data.orderId} total=${data.totalAmount}`);
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error || err.message;
    console.error(`[load-generator] request failed status=${status} message=${message}`);
  }
}

async function main() {
  console.log(`[load-generator] sending orders to ${GATEWAY_URL}`);
  // Give the rest of the stack a head start before hammering it.
  await sleep(10000);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await createOrder();
    await sleep(randomInt(MIN_INTERVAL_MS, MAX_INTERVAL_MS));
  }
}

main();
