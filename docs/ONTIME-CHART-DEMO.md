# On-time flights dashboard

[`examples/ontime-charts.json`](../examples/ontime-charts.json) is the flagship
analytical dashboard for the public `ontime` flight dataset. Open it on the
[Antalya demo](https://antalya.demo.altinity.cloud/sql) with **File ▾ → Open…**.

The authored grid contains seven visible tiles: Flight KPIs, Daily flights,
On-time rate, Busiest origins, Monthly carrier volume, Delay causes by carrier,
and Cancellation reasons. Additional chart analyses remain available as
untiled Library entries.

The active time range defaults to `2023-01-01` through `2023-12-31`. Carrier
and Origin airport start inactive and become searchable multiselects because
every targeted query declares `Array(String)` and uses `has(...)`. Airport
codes are the bound values; readable airport names are the labels.

The dashboard reads `ontime.fact_ontime` and joins
`ontime.dim_airports` for origin names. To refresh panel schema keys against
the configured connection, run:

```bash
node examples/mjs/build-ontime-charts.mjs
```

The generator preserves the authored tile order and sizes, filters and
defaults, KPI field configuration, semantic dashboard identity, and complete
`flow@1` fallback.
