# Serving the assets across a ClickHouse® cluster

In ClickHouse-native hosting, the Altinity® SQL Browser is served *from
ClickHouse itself* — there is no separate web server. (The containerized Caddy
runtime in [DEVELOPMENT.md](DEVELOPMENT.md) is the alternative that does use
one; this document is about the native mode.) That makes "how do the asset bytes reach every node?" a
real design question on a multi-node cluster, because **ClickHouse does not
replicate the `user_files/` directory**: it is a node-local folder.

This doc explains the trade-offs and what `deploy/install.sh` ships today.
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

### A. Push to each node's `user_files` (single node today)

`install.sh` (without `--cluster`) creates a `File`-engine table that writes the
bytes into the node's local `user_files/`. The handler serves them with a
`type=static` `file://` rule. **`install.sh --cluster` is currently broken** on
any cluster with more than one replica (see below); the multi-node variant of
this option is the manual procedure in
[Multi-node clusters](#multi-node-clusters-interim-manual).

- **Pro:** the page is served statically, with no authentication — exactly what
  an unauthenticated bootstrap page needs. Simple; pure `clickhouse-client`.
- **Con:** `user_files/` is node-local, so a replica **added or replaced later
  starts empty** — you re-run the install after a scale-out. The install also
  assumes every replica is up at the time it runs. **`--cluster` is broken:**
  `INSERT INTO FUNCTION clusterAllReplicas(...)` fails on any cluster with more
  than one replica (`Code 55 STORAGE_REQUIRES_PARAMETER`: Distributed write with
  more than one shard and no sharding key, regardless of `internal_replication`),
  and because the script runs under `set -e`, it exits after the failed `INSERT`
  and never reaches its `DROP TABLE`, so the temporary `_asb_*` table may be left
  behind (see the cleanup below). `install.sh --cluster` now refuses to run
  against a multi-replica cluster. Tracked in #692; use the manual procedure
  below, or option B.

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

`deploy/install.sh` implements **option A for a single node** (no `--cluster`).
It is the simplest mechanism, needs only a shell toolchain (see below), and
serves the bootstrap page anonymously. Multi-node clusters are not supported by
the installer yet (#692); see the interim procedure below. The trade-off to be
aware of:

> After scaling a cluster out (or replacing a node), re-install (or re-run the
> manual multi-node procedure) so the new replica's `user_files/` gets the assets.

For deployments where that re-push is undesirable — autoscaling fleets, frequent
node replacement — option B (replicated table) or option C (config-distributed
file) removes it. Both are straightforward to adopt: option B is a schema +
`predefined_query_handler` change to `deploy/`; option C is a change to how the
file is placed on the nodes, with the existing `file://` handler unchanged.

### Installer prerequisites

`deploy/install.sh` builds the SPA from a checkout, so it needs `npm` and
`node` (22 or newer) as well as `clickhouse-client`; `curl` is used only for
OIDC discovery (the CSP `connect-src` falls back to the Google default without
it). Each GitHub release also ships a prebuilt `sql.html` asset; if you do not
want to build, download it and upload it (plus a `sql-config.json`) to
`user_files/` yourself, then install `http_handlers.xml` as above. The installer
has no flag for this path.

## Multi-node clusters (interim, manual)

Until the installer is fixed (#692), pull each file onto every node with
`ON CLUSTER` DDL. Each node fetches the URL itself and writes its own
`user_files/` file. Run the sequence below **for both files** (`sql.html` and
`sql-config.json`); every step is idempotent, so on any failure you simply
start again from step 1.

**1. Pre-clean** (removes leftovers from an earlier partial run; `IF EXISTS`
because the table may exist on only some hosts):

```sql
DROP TABLE IF EXISTS default._asb_pull_sql_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_pull_sql_config_json ON CLUSTER '<cluster>' SYNC;
```

**2. Create** (each node writes its file as a side effect of the `CREATE`):

```sql
CREATE TABLE default._asb_pull_sql_html ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', 'sql.html')
  AS SELECT * FROM url('<url-serving-sql.html>', 'RawBLOB')
  SETTINGS engine_file_truncate_on_insert = 1;
```

For the config, use the JSON as a SQL string literal (this is what
`install.sh` renders into `sql-config.json`; adapt issuer/client id/audience):

```sql
CREATE TABLE default._asb_pull_sql_config_json ON CLUSTER '<cluster>'
  ENGINE = File('RawBLOB', 'sql-config.json')
  AS SELECT '{"issuer":"https://accounts.google.com","client_id":"<client-id>"}' AS c
  SETTINGS engine_file_truncate_on_insert = 1;
```

The JSON must be escaped for a SQL string literal: `'` becomes `\'` and `\`
becomes `\\`. A normal config contains neither, so it can be pasted as is. The
file is written without a trailing newline (harmless to the JSON parser).

**3. Drop the helper tables** (the files survive the `DROP`):

```sql
DROP TABLE IF EXISTS default._asb_pull_sql_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_pull_sql_config_json ON CLUSTER '<cluster>' SYNC;
```

**4. Verify on every node.** Compute the expected values locally from the
artifact you intended to deploy (`sha256sum sql.html`, or
`shasum -a 256 sql.html` on macOS; `wc -c < sql.html` for the length; likewise
for the config file, which is the exact JSON without a trailing newline). Then:

```sql
SELECT hostName(), length(c), lower(hex(SHA256(c))) AS sha256
FROM clusterAllReplicas('<cluster>', file('sql.html', 'RawBLOB', 'c String'));

SELECT count() FROM system.clusters WHERE cluster = '<cluster>';
```

(Repeat the first query with `sql-config.json`.) The deployment is successful
**only when** the first query returns exactly as many rows as the second
query's node count, and every row shows the expected length and hash, for both
files. A file missing on any node makes the verify query fail outright
(`FILE_DOESNT_EXIST`), which also counts as a failure.

**On any failure** (an `ON CLUSTER` statement errors, some nodes cannot reach
the URL, or step 4 does not match): run step 1 again and retry from the start.
A failed `CREATE ... ON CLUSTER` can leave `_asb_pull_*` tables on the hosts
where it succeeded; a retry without the pre-clean would hit
`TABLE_ALREADY_EXISTS`, and a plain `DROP ... ON CLUSTER` (without `IF EXISTS`)
fails with `UNKNOWN_TABLE` on hosts where the table was never created. The
`IF EXISTS` pre-clean avoids both. *The `IF EXISTS` recovery sequence follows
from the ClickHouse behavior observed in testing, but the full
partial-failure-then-retry flow was not separately tested.*

**Keep `engine_file_truncate_on_insert = 1`:** without it a re-run appends and
doubles the file.

- **Grants** (minimal): `CLUSTER ON *.*`, `CREATE TABLE, DROP TABLE ON default.*`,
  `FILE ON *.*`, `URL ON *.*`; verification also needs READ ON FILE and REMOTE.
- **Egress:** every node must reach the URL (e.g. the release asset
  `https://github.com/Altinity/altinity-sql-browser/releases/download/<tag>/sql.html`,
  or an internal mirror), and the host must be allowed by
  `remote_url_allow_hosts` if configured. GitHub release downloads redirect, so
  `url()` must follow redirects, or use a mirror that serves the bytes directly.

**Tested** on ClickHouse 25.8 OSS, 26.3 OSS and Antalya 25.8.33, on all four
nodes of a 2-shard x 2-replica cluster: byte-exact, idempotent with the
truncate setting. The `sql-config.json` literal statement was tested on a **single node of
ClickHouse 26.3 only** (byte-exact against the intended JSON, including a URL
with `?`/`&` and `\'`/`\\` escaping; idempotent on a re-run); its `ON CLUSTER`
behaviour is the same mechanism proven for `sql.html`, but was not separately
run on a multi-node cluster. **Not tested:** pulling from the real GitHub release
URL (a local HTTP server was used, so redirect handling is unverified). This
procedure is the planned basis of the fixed installer.

### Cleaning up after a failed `install.sh --cluster`

If you already ran the broken `--cluster` path, it may have left its temporary
tables behind on the node you connected to (and on other nodes where the
`ON CLUSTER` `CREATE` ran). Remove them:

```sql
DROP TABLE IF EXISTS default._asb_sql_html ON CLUSTER '<cluster>' SYNC;
DROP TABLE IF EXISTS default._asb_sql_config_json ON CLUSTER '<cluster>' SYNC;
```

Dropping a `File`-engine table does not delete the file in `user_files/`.

## Single-node installs

None of the above applies to a single node: `install.sh` without `--cluster` writes
the assets to the one node's `user_files/` and you are done.
