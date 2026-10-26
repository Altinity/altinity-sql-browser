# Serving the assets across a ClickHouse® cluster

In ClickHouse-native hosting, the Altinity® SQL Browser is served *from
ClickHouse itself* — there is no separate web server. (The containerized Caddy
runtime in [DEVELOPMENT.md](DEVELOPMENT.md) is the alternative that does use
one; this document is about the native mode.) That makes "how do the asset bytes reach every node?" a
real design question on a multi-node cluster, because **ClickHouse does not
replicate the `user_files/` directory**: it is a node-local folder.

This doc explains the trade-offs and what `deploy/install.sh` ships.
(A `docs/sql.html` mirror is also published to GitHub Pages on every tagged
release, for an unauthenticated try-it-now demo — see `release.yml` — but
that's a separate distribution channel from the cluster-serving problem
below, not a replacement for it: a real deployment still needs the bytes on
every ClickHouse node.)

## What has to reach every node

Two independent things must be present on every node that can answer a request:

1. **The `http_handlers` config** (a small XML fragment, `deploy/http_handlers.xml`).
   This already rides your existing config-management channel —
   clickhouse-operator, ACM cluster settings, a mounted ConfigMap, Ansible,
   etc. — which by construction reaches every node, including ones added later.
   Caveat: some managed providers forbid changes to `config.d/` or
   `http_handlers`. If you cannot install `http_handlers`, ClickHouse-native
   hosting is impossible; use the container image, the Helm chart, or any
   external static host instead (see [DEVELOPMENT.md](DEVELOPMENT.md)).

2. **The asset bytes** (`sql.html` and `sql-config.json`). `sql.html` is a
   single self-contained file of about 2 MB raw (measure your build:
   `ls -l dist/sql.html`); the config is tiny. HTTP compression (gzip/br)
   shrinks what goes over the wire to roughly a quarter to a third, but the
   stored file, and anything that caps stored size, sees the raw bytes. This is
   the part affected by `user_files/` being node-local.

## The options

There is no single "correct" mechanism — each is reasonable, with different
trade-offs. The key tension is **anonymous serving vs. native replication**: the
`/sql` bootstrap page is fetched by the browser *before* OAuth, so it must be
served without credentials, which favours a static handler; native replication
of the bytes favours a table, whose read path needs a user.

### A. Push to each node's `user_files` (what `deploy/install.sh` does)

`install.sh` writes the bytes into every node's local `user_files/` using SQL
only (no ssh, no per-node upload), and the handler serves them with a
`type=static` `file://` rule. With `--cluster` the fan-out is a server-side
`CREATE TABLE ... ON CLUSTER ... ENGINE = File('RawBLOB', ...) AS SELECT ...`;
see [How the installer works](#how-the-installer-works).

- **Pro:** the page is served statically, with no authentication — exactly what
  an unauthenticated bootstrap page needs. Pure SQL; verified per node, byte-exact.
- **Con:** `user_files/` is node-local, so a replica **added or replaced later
  starts empty** — re-run the install after a scale-out (it is idempotent and
  repairs any node). Every node must be up while it runs.

### B. Store the asset in a Replicated table + `predefined_query_handler`

Keep the bytes in a `ReplicatedMergeTree` table and serve them with a
`predefined_query_handler` running e.g.
`SELECT argMax(content, updated) FROM asb_assets WHERE name = 'sql.html' FORMAT RawBLOB`.

- **Pro:** ClickHouse replication distributes the bytes to every replica
  of the table's shard/replication group automatically, **including replicas
  added later**. A `ReplicatedMergeTree` does not replicate to other shards, so
  a multi-shard cluster needs the table (or its data) on each shard. Pure SQL, portable.
- **Con:** a `predefined_query_handler` runs the query as a ClickHouse user, so
  the unauthenticated `/sql` GET needs a small read-only grant on the assets
  table for whatever anonymous resolves to. The `Replicated*` engine's
  ZooKeeper/Keeper path is cluster-specific (macros).

### C. Ship the asset through config distribution

Place `sql.html` where your config channel puts it on every node — e.g.
clickhouse-operator `spec.configuration.files`, or a mounted ConfigMap — and
serve it with the same `file://` static handler.

- **Pro:** rides the exact channel that already distributes `http_handlers.xml`
  to all nodes, so new replicas are covered for free; still served statically
  (no auth, no read-grant).
- **Con:** the bytes live in config. The artifact is about 2 MB (measure your
  build), which is too large for several channels: clickhouse-operator
  `spec.configuration.files` lands in a Kubernetes ConfigMap, which is capped at
  1 MiB, and control planes that push settings inline (for example, ACM's
  setting-push has an ~8 KB URI limit) cannot carry it either. In practice it
  has to be a file delivered by some other mechanism (image layer, volume,
  init container), not an inline config value.

## What this project ships

`deploy/install.sh` implements **option A**, for one node or a whole cluster.
It is the simplest mechanism and serves the bootstrap page anonymously. The
trade-off to be aware of:

> After scaling a cluster out (or replacing a node), re-run the install so the
> new replica's `user_files/` gets the assets.

For deployments where that re-push is undesirable — autoscaling fleets, frequent
node replacement — option B (replicated table) or option C (config-distributed
file) removes it.

## Installing with `deploy/install.sh`

```bash
CLICKHOUSE_PASSWORD=… ./deploy/install.sh \
  --ch-host <any-node> --ch-user <deploy-user> --client-id <oauth-client-id> \
  --cluster <cluster-name> \
  [--artifact sql.html] [--pull-url <url>] [--transport native|http] [--http-port N] \
  [--ddl-timeout 180] [--verify-only] [--secure]
```

| Flag | Meaning |
|---|---|
| `--cluster C` | fan out to every node of cluster `C` (as named in `system.clusters` on the node you connect to). Without it only the connected node is updated (behind a load balancer that is one random node). |
| `--artifact PATH` | install this prebuilt `sql.html` (e.g. the release asset); skips the build, so no `npm`/`node` is needed. Required when there is no build tree (the release bundle). A zero-byte file is rejected before any write. |
| `--pull-url URL` | cluster mode: every node downloads the SPA from `URL` itself (needs egress + the `URL` grant). The bytes at `URL` **must equal the artifact** (`--artifact`, or the build): the installer verifies length and SHA-256 against the local artifact, so anything else fails phase-1 verification and the live files stay untouched. Mutually exclusive with `--verify-only`. Default is **stage** mode: the installer uploads once to the connected node and the nodes copy it over the interserver connection (no egress). |
| `--transport native\|http` | `native` (default) drives `clickhouse-client`; `http` uses `curl` against the HTTP(S) port (`--http-port`, default 8123 / 8443 with `--secure`). The password never appears in argv: with `http` it is sent from a 0600 header file, with `native` it is handed to `clickhouse-client` alone through its environment (never to `npm`, `node` or the OIDC `curl`). |
| `--http-port N` | HTTP(S) port for `--transport http` (default 8123, or 8443 with `--secure`). |
| `--ddl-timeout S` | `distributed_ddl_task_timeout` for the `ON CLUSTER` statements (default 180, **must be >= 1**: 0 makes ClickHouse run DDL asynchronously and the installer would verify too early). Also bounds a `--pull-url` download (`max_execution_time`, HTTP receive timeout). The cleanup at the end uses at most 30 s. `distributed_ddl_output_mode=throw` is pinned on every request, so a profile default of `never_throw` cannot hide a dead node. |
| `--verify-only` | change nothing; compare every node's live files to the artifact and exit non-zero on any mismatch. |

Credentials come from `CLICKHOUSE_PASSWORD` (or a prompt). **Check that a
personal `~/.clickhouse-client/config.xml` is not overriding the host, user or
password** you pass — `clickhouse-client` reads it and it can silently change
which server or account the installer talks to.

**One run at a time.** Concurrent installs or uninstalls against the same cluster are
unsupported (there is no lock): they share the `_asb_t_*` temp tables and the
`_asb_next_*` files and can corrupt each other.

**Proxies.** The scripts call `curl -q` (so `~/.curlrc` is ignored) but curl still honours
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`; the installer adds no `--noproxy`. With
`--transport http` over plain HTTP a configured proxy would see the credentials, so use
`--secure` or unset the proxy variables.

`uninstall.sh` takes the same connection flags and **empties** both files on
every node (0 bytes, verified) and also the `_asb_next_*` copies (they hold a full copy of
the SPA). SQL cannot delete a file, so `/sql` then answers
`200` with an empty body; remove the `http_handlers` fragment from `config.d/`
and reload to really disable the route.

### How the installer works

Two facts shape it, both proven on 25.8 OSS, 26.3 OSS and Antalya 25.8.33
([spike 1](https://github.com/Altinity/altinity-sql-browser/issues/692#issuecomment-6412840355),
and the follow-up design comment on #692): a write through `clusterAllReplicas`
is rejected (`Code 55`), so fan-out has to be `CREATE ... ON CLUSTER ... AS SELECT`
into a `File(RawBLOB)` table (the file survives the `DROP`); and **a failed
`CREATE ... AS SELECT` truncates its target file to 0 bytes**. So the live file
is never the target of anything that can fail on a remote source:

1. **Preflight** (no writes): the node count from `system.clusters`, and a
   `clusterAllReplicas` probe proving every node is reachable and cross-node reads authenticate.
2. **Pre-clean:** `DROP TABLE IF EXISTS default._asb_* ON CLUSTER ... SYNC` (a leftover
   table on one node would otherwise raise `TABLE_ALREADY_EXISTS` there), then both
   `_asb_next_*` files are **emptied on every node**, so a stale next file from an earlier
   run can never satisfy the phase-1 verification.
3. **Phase 1 — next files.** Stage mode uploads the artifact to the connected node as
   `_asb_stage_<token>.html` and every node copies it; `--pull-url` has every node
   `url()`-download it (following redirects). Result: `_asb_next_sql.html` and
   `_asb_next_sql-config.json` on every node. A failure here leaves the live files untouched.
4. **Verify phase 1:** every node's next files match the expected length and SHA-256. The
   check is strict: exactly one row per node (`count() = 1`), as many distinct `hostName()`s as
   `system.clusters` lists, each with the expected length and hash - a dropped, extra or
   duplicated-host row fails it. (`uninstall.sh`'s 0-byte check alone also accepts `count() = 0`.)
5. **Phase 2 — promote.** Each node copies *its own* verified `_asb_next_*` over the live
   `sql.html` / `sql-config.json` (a local read, so it cannot fail for network or auth reasons).
6. **Verify live:** per-node table; success only when every node matches.
7. **Always (trap):** the stage file is truncated and the temp tables dropped, with a DDL timeout capped at
   30 s, INT/TERM ignored while it runs, and the credential header file removed even if the cleanup SQL fails;
   live files are never touched by cleanup.

`_asb_next_*` is **intentionally kept as a full copy** next to the live files
(about 2 MB per node): it is the node-local, already-verified source for the
promote step, so promotion is a local read that cannot fail on network or auth. A node that is down during an `ON CLUSTER` statement
makes the installer fail after `--ddl-timeout`; the DDL stays queued and **replays
when the node returns, against whatever source exists then** — so after a failure
bring the node back and simply re-run the installer (idempotent) rather than
waiting for the replay. Re-running also repairs a node whose `user_files/` was
wiped or whose file was tampered with; `--verify-only` detects both.

### Requirements

- **Interserver authentication.** Cross-node reads (`clusterAllReplicas`) need the
  cluster to have a `<secret>` in `remote_servers` (the operator default) or per-replica
  `<user>/<password>`, and the deploy user must exist on **every** node. Without it the
  preflight fails with `AUTHENTICATION_FAILED (516)`. The `<secret>` path is what CI tests; the
  per-replica-credentials path was verified in a spike (#692) but is **not** in CI.
- **Grants** (tested; `READ`/`WRITE ON FILE` are covered by `FILE`):

  | Mode | Grants |
  |---|---|
  | stage (default) | `FILE ON *.*`, `CLUSTER ON *.*`, `REMOTE ON *.*`, `CREATE TABLE, DROP TABLE ON default.*`, `SELECT ON system.clusters` |
  | `--pull-url` | the above plus `URL ON *.*` |
  | `--verify-only` | `FILE`, `REMOTE`, `CREATE TEMPORARY TABLE ON *.*`, `SELECT ON system.clusters` |
  | single node (no `--cluster`) | tested with the stage grants; `CLUSTER`/`REMOTE` are not exercised |
  | `uninstall.sh` | same as stage |

  These sets are **tested sufficient** (every mode runs in CI as a user holding exactly that set; the
  `--verify-only` set also in a `deploy_verify` user). Minimality is only partly proven: the negative
  tests drop `REMOTE` and `URL` (both are rejected before any live file is touched, with a hint) and
  check that a `--verify-only`-only user cannot install; the other grants are not individually
  removed. `CREATE TEMPORARY TABLE` is what the `clusterAllReplicas(view(...))` verification query
  needs (found by the suite).
- **Egress** (`--pull-url` only): every node must reach the URL and `remote_url_allow_hosts`
  must permit it; GitHub release URLs redirect and are followed (up to 10 hops).

### Verifying by hand

Expected length and hash come from the artifact (`wc -c`, `sha256sum`); the query returns a
row per node even when the file is missing:

```sql
SELECT h, n, len, sha FROM clusterAllReplicas('<cluster>', view(
  SELECT hostName() h, count() n, sum(length(c)) len, lower(hex(SHA256(any(c)))) sha
  FROM file('sql.html', 'RawBLOB', 'c String')))
ORDER BY h SETTINGS engine_file_empty_if_not_exists = 1;
SELECT count() FROM system.clusters WHERE cluster = '<cluster>';
```

Repeat with `sql-config.json`. Success means exactly as many rows as the second query's
count, each with the expected `len`/`sha`.

### Failure and retry

Every step is idempotent: on any failure fix the cause and re-run the same command. If the
installer was killed, its trap may not have run: re-running pre-cleans the temp tables, but
a stale `_asb_stage_<token>.html` on the connected node (a plain copy of the SPA, never
served) stays until you truncate or delete it by hand.

### Tested

`tests/deploy/` (`npm run test:deploy`, CI job `deploy-integration`) runs the real scripts
against Keeper + a 2-shard x 2-replica cluster with a `<secret>`, a password-protected deploy
user holding exactly the grants above, and the shipped `http_handlers.xml`; every scenario
checks the byte-exact SHA-256 of `/sql` and `/sql/config.json` served by every node. Covered:
fresh install, upgrade, HTTP transport, `--pull-url` through a 2-hop redirect, wiped-node
repair, `--verify-only` on a tampered node and as the minimal `deploy_verify` user, a node stopped
before the run (the preflight rejects it), a node **killed mid-run** right after the stage upload
(installer fails, the other nodes keep the previous good version, the queued DDL replay settles,
re-install succeeds), an unreachable pull URL, missing `REMOTE` / `URL`
grants, a single node, and uninstall. Images (exact tags): `clickhouse/clickhouse-server:26.3.18.32` and
`altinity/clickhouse-server:25.8.33.20001.altinityantalya`, with `clickhouse/clickhouse-keeper:25.8.33.6`.
**Not covered:** the real GitHub release URL, TLS (`--secure`) against a live server, and the
per-replica-credentials interserver path. The script logic (strict row checks, cleanup, the
password's reach) is additionally unit-tested against a simulator.

## Appendix: manual SQL (same statements the installer runs)

For a restricted environment where you cannot run the script. Replace `<cluster>`; run for both
files, and verify as above before and after promoting. Pull mode shown (`<url>` serves
`sql.html`); `<json>` is the config JSON as a SQL string literal (`\` becomes `\\`, `'` becomes `\'`).

```sql
-- 1 pre-clean (drop the temp tables, then EMPTY the next files so a stale one cannot pass verification)
DROP TABLE IF EXISTS default._asb_t_next_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_t_next_cfg  ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_t_live_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_t_live_cfg  ON CLUSTER '<cluster>' SYNC;
CREATE TABLE default._asb_t_next_html ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', '_asb_next_sql.html')
  AS SELECT '' AS c SETTINGS engine_file_truncate_on_insert = 1;
CREATE TABLE default._asb_t_next_cfg ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', '_asb_next_sql-config.json')
  AS SELECT '' AS c SETTINGS engine_file_truncate_on_insert = 1;
DROP TABLE IF EXISTS default._asb_t_next_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_t_next_cfg  ON CLUSTER '<cluster>' SYNC;

-- 2 phase 1: next files (a failure here cannot hurt the live files)
CREATE TABLE default._asb_t_next_html ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', '_asb_next_sql.html')
  AS SELECT c FROM url('<url>', 'RawBLOB', 'c String')
  SETTINGS max_http_get_redirects = 10, engine_file_truncate_on_insert = 1,
           max_execution_time = 180, http_connection_timeout = 10, http_receive_timeout = 180;
CREATE TABLE default._asb_t_next_cfg ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', '_asb_next_sql-config.json')
  AS SELECT '<json>' AS c SETTINGS engine_file_truncate_on_insert = 1;
DROP TABLE IF EXISTS default._asb_t_next_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_t_next_cfg  ON CLUSTER '<cluster>' SYNC;

-- 3 verify _asb_next_sql.html and _asb_next_sql-config.json on every node (query above)

-- 4 phase 2: promote each node's OWN copy
CREATE TABLE default._asb_t_live_html ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', 'sql.html')
  AS SELECT c FROM file('_asb_next_sql.html', 'RawBLOB', 'c String')
  SETTINGS engine_file_truncate_on_insert = 1;
CREATE TABLE default._asb_t_live_cfg ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', 'sql-config.json')
  AS SELECT c FROM file('_asb_next_sql-config.json', 'RawBLOB', 'c String')
  SETTINGS engine_file_truncate_on_insert = 1;
DROP TABLE IF EXISTS default._asb_t_live_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_t_live_cfg  ON CLUSTER '<cluster>' SYNC;

-- 5 verify sql.html and sql-config.json on every node
```

Never point the step-4 `CREATE` at a remote source: a failed `CREATE ... AS SELECT`
empties its target. Keep `engine_file_truncate_on_insert = 1` (without it a re-run appends).
