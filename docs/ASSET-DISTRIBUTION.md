# Serving the assets across a ClickHouse® cluster

The Altinity® SQL Browser is served *from ClickHouse itself* — there is no
separate web server. That makes "how do the asset bytes reach every node?" a
real design question on a multi-node cluster, because **ClickHouse does not
replicate the `user_files/` directory**: it is a node-local folder.

This doc explains the trade-offs and what `deploy/install.sh` ships today.

## What has to reach every node

Two independent things must be present on every node that can answer a request:

1. **The `http_handlers` config** (a small XML fragment, `deploy/http_handlers.xml`).
   This already rides your existing config-management channel —
   clickhouse-operator, ACM cluster settings, a mounted ConfigMap, Ansible,
   etc. — which by construction reaches every node, including ones added later.
   No problem here.

2. **The ~65 KB asset bytes** (`sql.html` and `sql-config.json`). This is the
   part affected by `user_files/` being node-local.

## The options

There is no single "correct" mechanism — each is reasonable, with different
trade-offs. The key tension is **anonymous serving vs. native replication**: the
`/sql` bootstrap page is fetched by the browser *before* OAuth, so it must be
served without credentials, which favours a static handler; native replication
of the bytes favours a table, whose read path needs a user.

### A. Push to each node's `user_files` (what ships today)

`install.sh` creates a `File`-engine table and, for a cluster, uses
`INSERT INTO FUNCTION clusterAllReplicas(...)` to write the bytes into **every
replica's local `user_files/`**. The handler serves them with a `type=static`
`file://` rule.

- **Pro:** the page is served statically, with no authentication — exactly what
  an unauthenticated bootstrap page needs. Simple; pure `clickhouse-client`.
- **Con:** `user_files/` is node-local, so a replica **added or replaced later
  starts empty** — you re-run `install.sh` after a scale-out. The install also
  assumes every replica is up at the time it runs. **Multi-shard:**
  `clusterAllReplicas` can't write to a target with more than one shard, so
  `install.sh --cluster` only works on a single shard; on a multi-shard cluster
  run the installer **per node** (omit `--cluster`, point `--ch-host` at each
  node) or use option B. `install.sh` detects this and stops with guidance.

### B. Store the asset in a Replicated table + `predefined_query_handler`

Keep the bytes in a `ReplicatedMergeTree` table and serve them with a
`predefined_query_handler` running e.g.
`SELECT argMax(content, updated) FROM asb_assets WHERE name = 'sql.html' FORMAT RawBLOB`.

- **Pro:** ClickHouse replication distributes the bytes to every replica
  automatically, **including replicas added later**. Pure SQL, portable.
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
- **Con:** the bytes live in config. Inlining 65 KB needs CDATA/escaping, and
  some control planes cap inline config size (for example, ACM's setting-push
  has an ~8 KB URI limit), so in practice the asset goes in as a *mounted file*
  rather than an inline value.

## What this project ships

`deploy/install.sh` implements **option A**. It is the simplest mechanism, needs
nothing but `clickhouse-client`, and serves the bootstrap page anonymously. The
trade-off to be aware of:

> After scaling a cluster out (or replacing a node), re-run `install.sh` so the
> new replica's `user_files/` gets the assets.

For deployments where that re-push is undesirable — autoscaling fleets, frequent
node replacement — option B (replicated table) or option C (config-distributed
file) removes it. Both are straightforward to adopt: option B is a schema +
`predefined_query_handler` change to `deploy/`; option C is a change to how the
file is placed on the nodes, with the existing `file://` handler unchanged.

## Single-node installs

None of this applies to a single node: `install.sh` without `--cluster` writes
the assets to the one node's `user_files/` and you are done.
