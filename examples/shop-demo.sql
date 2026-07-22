-- Required setup for examples/shop-charts.json. Load this file once with:
--   clickhouse-client --multiquery < examples/shop-demo.sql
-- The portable dashboard bundle intentionally does not duplicate schema/data.
--
-- shop — a tiny demo schema that EXISTS to show the data-flow graph:
-- a raw events table feeding 3 materialized views into aggregate targets,
-- a dictionary sourced from a dimension table, and a view on an aggregate.
-- Generated data is intentionally small (50 products, 300k events / ~90 days).
--
-- On a replicated antalya cluster, wrap each statement in ON CLUSTER '{cluster}'
-- and use Replicated* engines so every replica has it; shown single-node here.
-- After loading, the demo user needs read access for the graph to draw fully:
--   GRANT SELECT ON system.dictionaries TO demo;   -- else no dict edges (Code 497)
--   GRANT SELECT ON shop.* TO demo;

CREATE DATABASE IF NOT EXISTS shop;

CREATE TABLE shop.events_raw
(
    event_time DateTime,
    user_id    UInt64,
    country    LowCardinality(String),
    product_id UInt32,
    amount     Decimal(10,2),
    event_type LowCardinality(String)
)
ENGINE = MergeTree ORDER BY (event_time, user_id);

CREATE TABLE shop.products
(
    product_id UInt32,
    name       String,
    category   LowCardinality(String)
)
ENGINE = MergeTree ORDER BY product_id;

-- Dictionary sourced from the products table (a `dict` edge in the graph).
-- The CLICKHOUSE source needs a user that can read shop.products on the server.
CREATE DICTIONARY shop.products_dict
(
    product_id UInt32,
    name       String,
    category   String
)
PRIMARY KEY product_id
SOURCE(CLICKHOUSE(TABLE 'products' DB 'shop'))
LIFETIME(MIN 300 MAX 600)
LAYOUT(HASHED());

CREATE TABLE shop.daily_sales
(
    day Date, country LowCardinality(String), orders UInt64, revenue Decimal(18,2)
)
ENGINE = SummingMergeTree ORDER BY (day, country);

CREATE TABLE shop.hourly_active_users
(
    hour DateTime, country LowCardinality(String), users AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree ORDER BY (hour, country);

CREATE TABLE shop.category_revenue
(
    day Date, category LowCardinality(String), revenue Decimal(18,2)
)
ENGINE = SummingMergeTree ORDER BY (day, category);

-- events_raw  --feeds-->  3 MVs  --writes-->  aggregate targets
CREATE MATERIALIZED VIEW shop.mv_daily_sales TO shop.daily_sales AS
SELECT toDate(event_time) AS day, country, count() AS orders, sum(amount) AS revenue
FROM shop.events_raw WHERE event_type = 'purchase' GROUP BY day, country;

CREATE MATERIALIZED VIEW shop.mv_hourly_active_users TO shop.hourly_active_users AS
SELECT toStartOfHour(event_time) AS hour, country, uniqState(user_id) AS users
FROM shop.events_raw GROUP BY hour, country;

CREATE MATERIALIZED VIEW shop.mv_category_revenue TO shop.category_revenue AS
SELECT toDate(event_time) AS day,
       dictGet('shop.products_dict', 'category', toUInt64(product_id)) AS category,
       sum(amount) AS revenue
FROM shop.events_raw WHERE event_type = 'purchase' GROUP BY day, category;

-- daily_sales  --reads-->  v_top_countries
CREATE VIEW shop.v_top_countries AS
SELECT country, sum(revenue) AS revenue
FROM shop.daily_sales GROUP BY country ORDER BY revenue DESC;

INSERT INTO shop.products
SELECT number, concat('Product ', toString(number)),
       ['Electronics','Books','Home','Toys','Garden'][(number % 5) + 1]
FROM numbers(50);

-- ~300k events spread over 90 days. Each dimension is seeded from a DIFFERENT
-- rand() so they're independent — otherwise (e.g. product and event_type both
-- keyed off number % 5) purchases would only ever hit a couple of categories.
INSERT INTO shop.events_raw
SELECT now() - toIntervalMinute(number % (90 * 24 * 60))            AS event_time,
       rand(number)     % 5000                                     AS user_id,
       ['US','GB','DE','FR','IN','BR','JP'][(rand(number + 1) % 7) + 1] AS country,
       rand(number + 2) % 50                                       AS product_id,
       round((rand(number + 3) % 48000) / 100 + 19.99, 2)          AS amount,
       ['purchase','view','cart','purchase'][(rand(number + 4) % 4) + 1] AS event_type
FROM numbers(300000);
