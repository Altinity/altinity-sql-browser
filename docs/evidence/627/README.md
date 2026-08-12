# Live ClickHouse 24.8 evidence — issue #627

Committed evidence for the two immutable historical-generation ClickHouse 24.8 images
named in issue #627 and the #585 spike's compatibility matrix. This is a one-off,
manually-run verification (see "Procedure" below); there is no permanent Docker-matrix
test harness for it, by design (the #585 spike harness was retired in #630 Phase 8, and
these two rows are pinned, immutable digests, not a maintained-forever regression suite).

## Tested commit

The live Docker capture below (raw `*.ndjson` bytes, `docker pull`/`docker run`,
image digests, and asserted `SELECT version()`) was performed against
`036760afe565db89a43f112fa37db3bf7f192257` (branch `wip/627-metaless-stream-columns`
— the same commit/branch as this repo's `fix/627-metaless-stream-columns`, not a
diverged fork). At that commit, `src/core/stream.ts`'s meta-less fallback had been
unchanged since this branch's first commit, `fe19ab7` (`fix(#627): preserve Table
results from ClickHouse 24.8 meta-less streams`).

That is **not** the branch's final head. A later commit on this same branch,
`edcb8ba7` (`fix(#627): restore row-width invariant for zero-key rows...`), added a
guard to the exact `json.row` fallback arm this evidence exercises: a zero-key `{}`
row arriving before columns are established is now declined rather than used to
"establish" zero-length columns (see that arm's comment in `src/core/stream.ts` for
the invariant it protects). Since acceptance criterion 7 is evidence-backed, this
document must attest to the code at the branch's final head, not only the commit
the live capture happened to run against — so the distinction matters:

* The guard **does not require re-running the live Docker capture** to validate: it
  is provably inert against the two `*.ndjson` captures committed here, because both
  carry only 3-key rows (`id`/`precise`/`lexical`) in every `row` line — never a
  zero-key `{}` row — so `keys.length === 0` never fires for this corpus, and
  replaying these exact bytes through `edcb8ba7`'s `stream.ts` reproduces the
  committed `*.normalized.json` files byte-for-byte.
* That replay is not just asserted here — it is a real, permanent regression test:
  `tests/unit/evidence-627-replay.test.ts` feeds both committed raw `*.ndjson`
  captures through the production `streamLines()` -> `applyStreamLine()` path at
  whatever commit `npm test` is run against, and asserts the result matches the
  committed `*.normalized.json` files exactly (and that the guard's zero-key branch
  never fires on this corpus). That test currently passes at `edcb8ba7` and every
  commit after it that leaves the corpus/guard behavior unchanged.

In short: the pinned image digests, `SELECT version()` assertions, and raw
`*.ndjson` bytes below are provenance of the **live capture**, dated to `036760a`;
the **decoder/accumulator behavior** they were run through is attested at the
branch's final head, `edcb8ba7`, via the committed replay test above — not frozen
at the live-capture commit.

## Execution date

2026-08-12 (UTC).

## Environment

* `DOCKER_NETWORK=iso-altinity` (created for this run; both containers attached to it).
* Docker server 29.4.0.

## Images and asserted versions

| Row | Image digest | Asserted `SELECT version()` |
|---|---|---|
| ClickHouse OSS | `clickhouse/clickhouse-server@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b` | `24.8.14.39` |
| Altinity Stable | `altinity/clickhouse-server@sha256:d0c456453ddc5220bc96e37c9b1f81eb210ca22fc0d6877dc9e71722ff43fa8f` | `24.8.14.10547.altinitystable` |

Both digests pulled cleanly on the first `docker pull` attempt (no registry-outage
retries were needed for this run).

## Query

```sql
SELECT
    if(number = 0, 'row-a', 'row-b') AS id,
    if(
        number = 0,
        '9007199254740993.12345678901234567890',
        '-9007199254740993.00000000000000000001'
    ) AS precise,
    if(number = 0, '001.2300', '0002') AS lexical
FROM numbers(2)
ORDER BY number
```

Requested with `default_format=JSONStringsEachRowWithProgress` over each container's
mapped `8123` port.

## Verification commands

A one-off verifier (not committed — built fresh in `$TMPDIR`, per the plan) ran, per image:

```sh
docker pull "$IMAGE"
docker run -d --rm --name "$NAME" --network="$DOCKER_NETWORK" \
  -p 127.0.0.1::8123 -e CLICKHOUSE_SKIP_USER_SETUP=1 "$IMAGE"
curl -fsS --data-binary 'SELECT version()' "http://127.0.0.1:${PORT}/"
curl -fsS --data-binary "$QUERY" \
  "http://127.0.0.1:${PORT}/?default_format=JSONStringsEachRowWithProgress" \
  > "$KEY.ndjson"
node verify-627.mjs "$KEY.ndjson" > "$KEY.normalized.json"
```

`verify-627.mjs` is an esbuild bundle of a small Node script that feeds the raw captured
bytes through the REAL production decoder/accumulator —
`@altinity/clickhouse-http`'s `streamLines()` (unmodified protocol mechanics) followed by
`src/core/stream.ts`'s `newResult()`/`applyStreamLine()` (the #627 result-policy fallback
under test) — then asserts the result against independently declared expected literals
(not read back from the result itself) before printing the normalized JSON committed here
as `*.normalized.json`.

## Independently declared expected columns/rows

```json
{
  "columns": [
    {"name":"id","type":""},
    {"name":"precise","type":""},
    {"name":"lexical","type":""}
  ],
  "rows": [
    ["row-a","9007199254740993.12345678901234567890","001.2300"],
    ["row-b","-9007199254740993.00000000000000000001","0002"]
  ]
}
```

## Results

Both rows pass every assertion in the plan's live pass/fail definition:

| Assertion | OSS 24.8.14.39 | Altinity Stable 24.8.14.10547 |
|---|---|---|
| Exact image digest pulled | yes | yes |
| `SELECT version()` matches expected | yes | yes |
| Raw captured stream reaches EOF with **no** `meta` record | confirmed — see `*.ndjson`; no `"meta"` line present | confirmed — see `*.ndjson`; no `"meta"` line present |
| Production `streamLines()` parses the actual captured bytes | yes (no parse error) | yes (no parse error) |
| Production `applyStreamLine()` yields the exact 3 expected columns, all `type: ''` | yes | yes |
| Both rows match the independently declared literals exactly (leading/trailing lexical precision preserved) | yes | yes |
| `result.error === null` | yes | yes |
| `result.capped === false` | yes | yes |

See `oss-24.8.14.39.normalized.json` / `altinity-24.8.14.10547.normalized.json` for the
exact printed `{metaSeen, columns, rows, error, capped}` object from each run, and
`oss-24.8.14.39.ndjson` / `altinity-24.8.14.10547.ndjson` for the exact raw bytes each
server sent (progress lines, then two `row` lines, never a `meta` line).

The separate accumulator-to-grid unit regression
(`tests/unit/grid-render.test.ts`'s "faithfully renders a meta-less accumulated result
(#627)..." case) independently confirms these same literals render unchanged as Table
cell text through the real `renderGrid()` — see that test for the DOM-level proof; it is
not re-run against these captured bytes here, since it already covers the
`StreamResult -> renderGrid` half of the pipeline with its own independently declared
literals.

`tests/unit/evidence-627-replay.test.ts` (added in PR review pass 1, see "Tested
commit" above) is the ongoing, head-tracking counterpart to the one-off verifier
above: it replays these exact two committed `*.ndjson` files through the real
`streamLines()`/`applyStreamLine()` production path at whatever commit `npm test`
runs against, and fails the suite if that ever stops matching the committed
`*.normalized.json` files — so this evidence's attestation does not silently go
stale again the next time `src/core/stream.ts`'s fallback changes.

## Transient pull retries

None needed for this run — both exact digests pulled successfully on the first attempt.

## Files in this directory

```text
README.md                                this file
oss-24.8.14.39.ndjson                    raw captured JSONStringsEachRowWithProgress bytes (OSS)
oss-24.8.14.39.normalized.json           production decoder/accumulator output (OSS)
altinity-24.8.14.10547.ndjson            raw captured bytes (Altinity Stable)
altinity-24.8.14.10547.normalized.json   production decoder/accumulator output (Altinity Stable)
```

The temporary verifier source/bundle used to produce these files was **not** committed,
per the plan — only its output.
