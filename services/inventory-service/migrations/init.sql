CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS inventory (
    product_id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    quantity_available INTEGER NOT NULL CHECK (quantity_available >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservations_order_id ON reservations (order_id);

-- Low/zero stock on a couple of these on purpose, to trigger failures too.
INSERT INTO inventory (product_id, product_name, quantity_available) VALUES
    ('sku-widget',    'Widget',    500),
    ('sku-gadget',    'Gadget',    200),
    ('sku-gizmo',     'Gizmo',     15),
    ('sku-doohickey', 'Doohickey', 5),
    ('sku-thingamajig','Thingamajig', 0)
ON CONFLICT (product_id) DO NOTHING;
