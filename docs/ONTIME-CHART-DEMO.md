# Chart demo — the `ontime` flight dataset

A ready-made **Library** of 10 analytical queries that show off every chart type and
feature in the Altinity® SQL Browser, running against the public US flight-history
dataset (`ontime`, ~230M rows, 1987–2025) on the Antalya demo cluster.

- **Live demo:** **https://antalya.demo.altinity.cloud/sql**
- **The library file:** [`examples/ontime-charts.json`](../examples/ontime-charts.json)
  ([raw download](https://raw.githubusercontent.com/Altinity/altinity-sql-browser/main/examples/ontime-charts.json))
- **Reproduce it:** [`examples/build-ontime-charts.mjs`](../examples/build-ontime-charts.mjs)
  regenerates the JSON (it derives each chart's schema key live with
  `clickhouse-client --connection antalya`).

## Load it (≈30 seconds)

1. Open **https://antalya.demo.altinity.cloud/sql** and sign in (**Continue with Google**,
   or use the credentials box).
2. Download [`ontime-charts.json`](https://raw.githubusercontent.com/Altinity/altinity-sql-browser/main/examples/ontime-charts.json)
   (right-click → Save link as…).
3. In the header, click **File ▾ → Open…** and pick the file. The library is renamed
   **ontime-charts** and fills with 10 saved queries (confirm the replace if you already
   had queries saved).
4. Click any query in the **Library** panel — it runs and opens straight into its chart.
   Switch **Table / JSON / Chart** at the top of the results, or change the **Type / X / Y /
   Series** dropdowns to re-encode any chart live.

## What each query demonstrates

| # | Query | Chart | Feature |
|---|-------|-------|---------|
| 1 | Busiest origin airports — 2023 | Bar (horizontal) | categorical axis; joined to `dim_airports` for readable names; hover any bar (long or short) for its exact value |
| 2 | Flights by month — 2023 | Column | numeric `month` auto-detected as an ordinal axis; K/M-humanised value ticks |
| 3 | Daily flights — 2023 | Line | `Date` axis auto-detected as a time series (~365 points) |
| 4 | Daily on-time rate — 2023 | Area | filled time series (a percentage measure) |
| 5 | Cancellation reasons — 2023 | Pie | share of a small category set, with a legend |
| 6 | Monthly flights by carrier — 2023 | Grouped bars | a **Series** column (carrier) splits each month into per-carrier bars |
| 7 | Average delay breakdown by carrier — 2023 | Multi-measure columns | four measures plotted together (“All measures”) |
| 8 | Daily flights since 2022 | Line | result exceeds the chart cap → a **“first 500 of 1.5K rows”** note (the table keeps them all) |
| 9 | Flights by day of week — 2023 | Column | ordinal `dayofweek` axis |
| 10 | Worst average departure delay by airport — 2023 | Bar (horizontal) | a non-count measure (avg minutes), joined for names |

Each saved query stores its chart configuration, so it reopens exactly as designed. (Charts
plot the first 500 rows; the full result is always available in the Table view.)

## Direct links

Every query is also reachable as a single shareable link — open one and the SQL **and** its
chart configuration are pre-loaded; press **Run**, then the **Chart** tab. (Inside the app,
the **Share** button copies the same kind of link for whatever you're looking at.)

- **Bar** — [Busiest origin airports — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUXG4gICAgYS5EaXNwbGF5QWlycG9ydE5hbWUgQVMgYWlycG9ydCxcbiAgICBjb3VudCgpIEFTIGZsaWdodHNcbkZST00gb250aW1lLmZhY3Rfb250aW1lIEFTIGZcbklOTkVSIEpPSU4gb250aW1lLmRpbV9haXJwb3J0cyBBUyBhXG4gICAgT04gYS5BaXJwb3J0Q29kZSA9IGYuT3JpZ2luQ29kZSBBTkQgYS5Jc0xhdGVzdCA9IDFcbldIRVJFIGYuWWVhciA9IDIwMjNcbkdST1VQIEJZIGFpcnBvcnRcbk9SREVSIEJZIGZsaWdodHMgREVTQ1xuTElNSVQgMTUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImhiYXIiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6ImFpcnBvcnQ6U3RyaW5nfGZsaWdodHM6VUludDY0In19)
- **Column** — [Flights by month — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIE1vbnRoIEFTIG1vbnRoLCBjb3VudCgpIEFTIGZsaWdodHNcbkZST00gb250aW1lLmZhY3Rfb250aW1lXG5XSEVSRSBZZWFyID0gMjAyM1xuR1JPVVAgQlkgbW9udGhcbk9SREVSIEJZIG1vbnRoIiwiY2hhcnQiOnsiY2ZnIjp7InR5cGUiOiJiYXIiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6Im1vbnRoOlVJbnQ4fGZsaWdodHM6VUludDY0In19)
- **Line** — [Daily flights — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIEZsaWdodERhdGUgQVMgZGF0ZSwgY291bnQoKSBBUyBmbGlnaHRzXG5GUk9NIG9udGltZS5mYWN0X29udGltZVxuV0hFUkUgWWVhciA9IDIwMjNcbkdST1VQIEJZIGRhdGVcbk9SREVSIEJZIGRhdGUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImxpbmUiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6ImRhdGU6RGF0ZXxmbGlnaHRzOlVJbnQ2NCJ9fQ==)
- **Area** — [Daily on-time rate — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUXG4gICAgRmxpZ2h0RGF0ZSBBUyBkYXRlLFxuICAgIHJvdW5kKDEwMCAqIGNvdW50SWYoQXJyRGVsMTUgPSAwKSAvIGNvdW50KCksIDEpIEFTIG9uX3RpbWVfcGN0XG5GUk9NIG9udGltZS5mYWN0X29udGltZVxuV0hFUkUgWWVhciA9IDIwMjNcbkdST1VQIEJZIGRhdGVcbk9SREVSIEJZIGRhdGUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImFyZWEiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6ImRhdGU6RGF0ZXxvbl90aW1lX3BjdDpGbG9hdDY0In19)
- **Pie** — [Cancellation reasons — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUXG4gICAgbXVsdGlJZihDYW5jZWxsYXRpb25Db2RlID0gJ0EnLCAnQ2FycmllcicsXG4gICAgICAgICAgICBDYW5jZWxsYXRpb25Db2RlID0gJ0InLCAnV2VhdGhlcicsXG4gICAgICAgICAgICBDYW5jZWxsYXRpb25Db2RlID0gJ0MnLCAnTmF0aW9uYWwgQWlyIFN5c3RlbScsXG4gICAgICAgICAgICBDYW5jZWxsYXRpb25Db2RlID0gJ0QnLCAnU2VjdXJpdHknLCAnT3RoZXInKSBBUyByZWFzb24sXG4gICAgY291bnQoKSBBUyBjYW5jZWxsYXRpb25zXG5GUk9NIG9udGltZS5mYWN0X29udGltZVxuV0hFUkUgWWVhciA9IDIwMjMgQU5EIENhbmNlbGxlZCA9IDFcbkdST1VQIEJZIHJlYXNvblxuT1JERVIgQlkgY2FuY2VsbGF0aW9ucyBERVNDIiwiY2hhcnQiOnsiY2ZnIjp7InR5cGUiOiJwaWUiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6InJlYXNvbjpTdHJpbmd8Y2FuY2VsbGF0aW9uczpVSW50NjQifX0=)
- **Grouped columns** — [Monthly flights by carrier — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUXG4gICAgTW9udGggQVMgbW9udGgsXG4gICAgQ2FycmllciBBUyBjYXJyaWVyLFxuICAgIGNvdW50KCkgQVMgZmxpZ2h0c1xuRlJPTSBvbnRpbWUuZmFjdF9vbnRpbWVcbldIRVJFIFllYXIgPSAyMDIzIEFORCBDYXJyaWVyIElOICgnV04nLCAnQUEnLCAnREwnLCAnVUEnKVxuR1JPVVAgQlkgbW9udGgsIGNhcnJpZXJcbk9SREVSIEJZIG1vbnRoLCBjYXJyaWVyIiwiY2hhcnQiOnsiY2ZnIjp7InR5cGUiOiJiYXIiLCJ4IjowLCJ5IjpbMl0sInNlcmllcyI6MX0sImtleSI6Im1vbnRoOlVJbnQ4fGNhcnJpZXI6TG93Q2FyZGluYWxpdHkoU3RyaW5nKXxmbGlnaHRzOlVJbnQ2NCJ9fQ==)
- **Multi-measure columns** — [Average delay breakdown by carrier — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUXG4gICAgQ2FycmllciBBUyBjYXJyaWVyLFxuICAgIHJvdW5kKGF2ZyhDYXJyaWVyRGVsYXkpLCAxKSBBUyBjYXJyaWVyX2RlbGF5LFxuICAgIHJvdW5kKGF2ZyhXZWF0aGVyRGVsYXkpLCAxKSBBUyB3ZWF0aGVyX2RlbGF5LFxuICAgIHJvdW5kKGF2ZyhOQVNEZWxheSksIDEpIEFTIG5hc19kZWxheSxcbiAgICByb3VuZChhdmcoTGF0ZUFpcmNyYWZ0RGVsYXkpLCAxKSBBUyBsYXRlX2FpcmNyYWZ0X2RlbGF5XG5GUk9NIG9udGltZS5mYWN0X29udGltZVxuV0hFUkUgWWVhciA9IDIwMjMgQU5EIEFyckRlbDE1ID0gMVxuR1JPVVAgQlkgY2FycmllclxuT1JERVIgQlkgY2Fycmllcl9kZWxheSBERVNDXG5MSU1JVCAxMiIsImNoYXJ0Ijp7ImNmZyI6eyJ0eXBlIjoiYmFyIiwieCI6MCwieSI6WzEsMiwzLDRdLCJzZXJpZXMiOm51bGx9LCJrZXkiOiJjYXJyaWVyOkxvd0NhcmRpbmFsaXR5KFN0cmluZyl8Y2Fycmllcl9kZWxheTpOdWxsYWJsZShGbG9hdDY0KXx3ZWF0aGVyX2RlbGF5Ok51bGxhYmxlKEZsb2F0NjQpfG5hc19kZWxheTpOdWxsYWJsZShGbG9hdDY0KXxsYXRlX2FpcmNyYWZ0X2RlbGF5Ok51bGxhYmxlKEZsb2F0NjQpIn19)
- **Line (capped)** — [Daily flights since 2022](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIEZsaWdodERhdGUgQVMgZGF0ZSwgY291bnQoKSBBUyBmbGlnaHRzXG5GUk9NIG9udGltZS5mYWN0X29udGltZVxuV0hFUkUgRmxpZ2h0RGF0ZSA+PSAnMjAyMi0wMS0wMSdcbkdST1VQIEJZIGRhdGVcbk9SREVSIEJZIGRhdGUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImxpbmUiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6ImRhdGU6RGF0ZXxmbGlnaHRzOlVJbnQ2NCJ9fQ==)
- **Column** — [Flights by day of week — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIERheU9mV2VlayBBUyBkYXlvZndlZWssIGNvdW50KCkgQVMgZmxpZ2h0c1xuRlJPTSBvbnRpbWUuZmFjdF9vbnRpbWVcbldIRVJFIFllYXIgPSAyMDIzXG5HUk9VUCBCWSBkYXlvZndlZWtcbk9SREVSIEJZIGRheW9md2VlayIsImNoYXJ0Ijp7ImNmZyI6eyJ0eXBlIjoiYmFyIiwieCI6MCwieSI6WzFdLCJzZXJpZXMiOm51bGx9LCJrZXkiOiJkYXlvZndlZWs6VUludDh8ZmxpZ2h0czpVSW50NjQifX0=)
- **Bar** — [Worst average departure delay by airport — 2023](https://antalya.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUXG4gICAgYS5EaXNwbGF5QWlycG9ydE5hbWUgQVMgYWlycG9ydCxcbiAgICByb3VuZChhdmcoZi5EZXBEZWxheU1pbnV0ZXMpLCAxKSBBUyBhdmdfZGVwX2RlbGF5XG5GUk9NIG9udGltZS5mYWN0X29udGltZSBBUyBmXG5JTk5FUiBKT0lOIG9udGltZS5kaW1fYWlycG9ydHMgQVMgYVxuICAgIE9OIGEuQWlycG9ydENvZGUgPSBmLk9yaWdpbkNvZGUgQU5EIGEuSXNMYXRlc3QgPSAxXG5XSEVSRSBmLlllYXIgPSAyMDIzXG5HUk9VUCBCWSBhaXJwb3J0XG5IQVZJTkcgY291bnQoKSA+PSAxMDAwMFxuT1JERVIgQlkgYXZnX2RlcF9kZWxheSBERVNDXG5MSU1JVCAxNSIsImNoYXJ0Ijp7ImNmZyI6eyJ0eXBlIjoiaGJhciIsIngiOjAsInkiOlsxXSwic2VyaWVzIjpudWxsfSwia2V5IjoiYWlycG9ydDpTdHJpbmd8YXZnX2RlcF9kZWxheTpOdWxsYWJsZShGbG9hdDY0KSJ9fQ==)

## Tables used

- `ontime.fact_ontime` — one row per US domestic flight (dates, carrier, origin/dest, delays, cancellations, …).
- `ontime.dim_airports` — airport reference data; joined on `AirportCode = OriginCode AND IsLatest = 1` for human-readable airport names.
