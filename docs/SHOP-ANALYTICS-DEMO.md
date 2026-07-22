# Shop analytics dashboard

The Shop example has two deliberately separate artifacts:

- [`examples/shop-demo.sql`](../examples/shop-demo.sql) creates the `shop`
  schema, sample events/products, dictionary, materialized views, aggregate
  tables, and lineage relationships.
- [`examples/shop-charts.json`](../examples/shop-charts.json) contains the
  reusable queries and authored dashboard, without duplicating setup SQL.

Load the SQL once with a suitably privileged ClickHouse client, then open the
bundle with **File ▾ → Open…**. The dashboard shows Sales KPIs, Daily revenue,
Revenue by country, Revenue by category, Top products, Daily active users, and
Traffic by hour. Country revenue trends remain as an untiled Library analysis.

The active range defaults to `-90d` through `now`. Country and Category are
inactive searchable multiselects. Their target lists are explicit because the
aggregate tables intentionally do not all carry both dimensions.

The setup user needs create/insert privileges for `shop.*`. Dashboard users
need `SELECT ON shop.*`; `SELECT ON system.dictionaries` is also required to
show dictionary lineage. The dictionary's ClickHouse source user must be able
to read `shop.products`.
