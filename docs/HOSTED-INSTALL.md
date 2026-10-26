# Hosted install runbook: restricted and multi-node ClickHouse®

The operator procedure for serving the Altinity® SQL Browser **from ClickHouse itself** when you can run
SQL but cannot touch the server filesystem (Altinity Cloud, clickhouse-operator, other managed
clusters), on a single node, a replicated shard or a multi-shard cluster.

The mechanism, its design and the installer flags live in
[ASSET-DISTRIBUTION.md](ASSET-DISTRIBUTION.md) (canonical; this page does not repeat them). The generic
install sequence is [DEPLOYMENT.md](DEPLOYMENT.md). This page answers: *can I do it here, with which
grants, and what exactly do I run?*

Legend: **[tested]** = exercised by `tests/deploy/` (CI, real ClickHouse, 2 shards x 2 replicas).
**[probed]** = run by hand against a single-node `clickhouse-server:26.3.18.32` while writing this page.
**[untested]** = stated from documentation or design; verify in your environment.

Tested versions: ClickHouse **26.3.18.32** and Altinity Antalya **25.8.33.20001** (full suite); **25.8 OSS**
only partly (the original #692 experiments). Other versions: expect the same, verify with
`--verify-only` and the checks below.

## 1. Preflight

### 1.1 Which procedure?

Two things must reach every node: the **`http_handlers` config** and the **asset bytes** (see
ASSET-DISTRIBUTION). Answer these in order.

| # | Question | How to check | If no |
|---|---|---|---|
| 1 | Can you push a `config.d` fragment (`http_handlers`) to every node, including future ones? | Altinity Cloud: ACM cluster setting `config.d/sql-browser.xml`. clickhouse-operator: `spec.configuration.files` (section 3d). Self-managed: `config.d/`. No SQL check exists; try it (section 5). | **ClickHouse-native hosting is impossible.** Use the container image, the Helm chart or any static host: [DEVELOPMENT.md](DEVELOPMENT.md#docker). |
| 2 | Is the `File` engine / `file()` available, and may your user use it? | Probe 1.3(c). | Standalone runtime as above. **ClickHouse Cloud** does not offer the File engine **[untested here]**: use the standalone runtime. |
| 3 | Is the cluster (or single node) defined and visible to your user? | Probe 1.3(b). | Fix the cluster name; single node needs no cluster. |
| 4 | Do cross-node reads authenticate (cluster `<secret>`, or per-replica credentials, and the deploy user on every node)? | Probe 1.3(d). Needed for `--cluster` in **both** modes. | `AUTHENTICATION_FAILED (516)`: ask for a `<secret>` in `remote_servers` (the clickhouse-operator can generate one, section 3d). Without it use single-node mode against each node you can reach, or the container image. |
| 5 | Can every node reach the artifact URL (and does `remote_url_allow_hosts` permit it)? | Probe 1.3(e). | Use the default **stage** mode (no egress, needs `REMOTE`). |
| 6 | Native protocol reachable from where you run the installer? | `clickhouse-client --host H --secure -q 'SELECT 1'`. | `--transport http` (HTTP(S) port only). |

| Topology | Procedure | Flags |
|---|---|---|
| Single node | Single-node install. Writes with `file()`. Tested with the stage grant set (section 2). It runs `INSERT INTO FUNCTION file(...)`, `SELECT ... FROM file(...)` and `DROP TABLE IF EXISTS default._asb_t_*`, so `FILE` + `DROP TABLE ON default.*` is the likely floor **[not verified]**. | no `--cluster` |
| One shard, several replicas | Cluster install; every replica gets its own copy. Behind a load balancer **always** pass `--cluster`, or one random replica is updated. | `--cluster <name>` |
| Several shards | Same; the installer fans out to every shard and replica and fails closed if any node is missing. | `--cluster <name>` |
| No node egress | stage mode (default). | |
| Nodes can reach the artifact | `--pull-url` is optional (saves one upload through the connected node). | `--pull-url <url>` |
| HTTP(S) only | `--transport http [--secure] [--http-port N]` | |

### 1.2 What the installer needs from you, in one place

Run as a user with the section 2 grants. **Check that a personal `~/.clickhouse-client/config.xml` is not
overriding host, user or password.** Every statement below is one the installer itself runs, except where
marked.

### 1.3 Preflight SQL

Run as the deploy user, on the node or endpoint you will pass as `--ch-host`. Send **one statement per
request** over HTTP(S); keep the credentials out of argv and shell history in a 0600 header file, as the
installer does:

```bash
( umask 077; printf 'X-ClickHouse-User: %s\nX-ClickHouse-Key: %s\n' "$U" "$CLICKHOUSE_PASSWORD" > pwheader.txt )
# put one statement in probe.sql, then:
curl -sS --data-binary @probe.sql -H @pwheader.txt 'https://H:8443/?wait_end_of_query=1'
```

**(a) Grants** **[probed]**

```sql
SHOW GRANTS;
```
Compare with section 2. Grants given through a role show up under the role; use `SHOW GRANTS FOR CURRENT_USER`
**[untested]** when in doubt.

**(b) Clusters visible to you, node counts** **[probed on a single node; the installer uses the
`count()` form per cluster]**

```sql
SELECT cluster, count() AS nodes, countDistinct(shard_num) AS shards, max(replica_num) AS max_replica_num
FROM system.clusters GROUP BY cluster ORDER BY cluster;
```
Pass one of these names to `--cluster`. The name must match `[A-Za-z0-9_.-]+`: a macro such as `{cluster}` is
**rejected** by the installer; use the name this query returns. Run it **on the node you connect to**: another
node can define different clusters.

**(c) Probe write, read, truncation of a tiny file** **[probed]** (the installer's single-node write uses the same
`INSERT INTO FUNCTION file(...)` form and `engine_file_truncate_on_insert`). Four statements; over HTTP(S) send
each in its own request.

```sql
INSERT INTO FUNCTION file('_asb_probe', 'RawBLOB') SETTINGS engine_file_truncate_on_insert = 1 SELECT 'probe';
SELECT c FROM file('_asb_probe', 'RawBLOB', 'c String');       -- expect: probe
INSERT INTO FUNCTION file('_asb_probe', 'RawBLOB') SETTINGS engine_file_truncate_on_insert = 1 SELECT '';
SELECT count() AS n, sum(length(c)) AS bytes
FROM file('_asb_probe', 'RawBLOB', 'c String') SETTINGS engine_file_empty_if_not_exists = 1;   -- expect: 0  0
```
`ACCESS_DENIED` means a missing `FILE` grant; any other error means `file()` is disabled or restricted on this
server (condition 2 fails). SQL cannot delete files, so the probe leaves a **0-byte `_asb_probe`** in
`user_files/`; it is never served and harmless.

**(d) Interserver authentication and node identity** (the installer's own preflight)
**[tested on 2x2 via the installer; probed on a single node]**

```sql
SELECT toString(serverUUID()) AS id, hostName() AS host
FROM clusterAllReplicas('<cluster>', view(SELECT 1)) ORDER BY host;
```
Expect one row per node of (b) with distinct `id`s. `AUTHENTICATION_FAILED (516)` = no cluster `<secret>` /
per-replica credentials, or the deploy user is missing on some node. Fewer rows or repeated ids fail the
installer too.

**(e) Node egress** (only for `--pull-url`; needs the `URL` grant) **[probed]** against the real release URL
from a single node: one 2,126,368-byte download through GitHub's redirect. Not run through the installer
(`tests/deploy/` uses a local 2-hop redirect). Use your mirror URL if you have one.

```sql
SELECT hostName() AS host, bytes FROM clusterAllReplicas('<cluster>', view(
  SELECT sum(length(c)) AS bytes
  FROM url('https://github.com/Altinity/altinity-sql-browser/releases/latest/download/sql.html', 'RawBLOB', 'c String')
  SETTINGS max_http_get_redirects = 10, http_connection_timeout = 10, max_execution_time = 60));
```
Every node must return the same non-zero `bytes`. (The `clusterAllReplicas` form of this probe was only run on a
single node; the plain `SELECT ... FROM url(...)` inside it is the part exercised.)

**(f) Existing install state** **[tested: it is the installer's own check]**

```sql
SELECT id, host, n, len, sha FROM clusterAllReplicas('<cluster>', view(
  SELECT toString(serverUUID()) id, hostName() host, count() n, sum(length(c)) len, lower(hex(SHA256(any(c)))) sha
  FROM file('sql.html', 'RawBLOB', 'c String'))) ORDER BY host, id SETTINGS engine_file_empty_if_not_exists = 1;
```
A node that has no file returns a row with `len = 0`. Compare `len` and `sha` with `wc -c` / `sha256sum` of the
artifact. `./deploy/install.sh ... --verify-only` does this and the preflight without changing anything, and is
the safest end-to-end rehearsal of connectivity and grants. **Repeat the exact OAuth flags used at install
time** (`--client-id`, `--issuer`, `--audience`, `--ch-auth`): the expected `sql-config.json` hash is rendered
from them, so different flags report a false MISMATCH.

## 2. Tested grants

Create the user on **every** node (or through your replicated access storage / `ON CLUSTER`
**[untested]**), then, per mode. The canonical statement of what is tested, what is only partly proven and
why is [ASSET-DISTRIBUTION.md, Requirements](ASSET-DISTRIBUTION.md#requirements); the block below is only a
copy-paste form of it (mirrors ASSET-DISTRIBUTION → Requirements; update both). It is what the CI user holds
(`tests/deploy/cfg/users.xml`) on 26.3.18.32 and Antalya 25.8.33.

```sql
-- stage mode (default) install and uninstall
GRANT CLUSTER ON *.* TO asb_deploy;
GRANT FILE ON *.* TO asb_deploy;
GRANT REMOTE ON *.* TO asb_deploy;
GRANT CREATE TABLE, DROP TABLE ON default.* TO asb_deploy;
GRANT SELECT ON system.clusters TO asb_deploy;

-- add for --pull-url
GRANT URL ON *.* TO asb_deploy;

-- verify-only user (separate account, no install rights)
GRANT FILE ON *.* TO asb_verify;
GRANT REMOTE ON *.* TO asb_verify;
GRANT CREATE TEMPORARY TABLE ON *.* TO asb_verify;
GRANT SELECT ON system.clusters TO asb_verify;
```

Notes: sufficiency is tested, minimality only partly (see ASSET-DISTRIBUTION "Requirements"). A single-node
install was tested only with the full stage set; it also runs `DROP TABLE IF EXISTS default._asb_t_*`, so it
needs at least `DROP TABLE ON default.*` besides `FILE` (likely floor, **not verified**). The `default` database in `ON
default.*` must exist on every node; if your policy forbids `default`, the temp-table names are fixed to
`default._asb_t_*` **[untested elsewhere]**. Revoke or drop the user when you are done; none of this is
needed to *serve* the app.

## 3. End-to-end examples

Common: get the artifact. A release publishes `sql.html`; the release bundle ships `deploy/` from the first
release after #692 (the v0.7.3 bundle does not), so until then use a checkout of this repository at the tag or
`main` and pass the downloaded file as `--artifact` (no `npm`/`node` needed):

```bash
curl -fsSL -o sql.html https://github.com/Altinity/altinity-sql-browser/releases/latest/download/sql.html
```

Set the password in the environment, not on the command line: `export CLICKHOUSE_PASSWORD=…` (or let the
installer prompt). `--client-id`, `--issuer`, `--audience`, `--ch-auth` are the OAuth settings from
[DEPLOYMENT.md](DEPLOYMENT.md#4-make-clickhouse-accept-the-jwt).

### (a) Self-managed, native protocol **[tested]**

```bash
./deploy/install.sh --ch-host ch1.example.com --ch-user asb_deploy \
  --client-id <oauth-client-id> --issuer https://idp.example.com \
  --cluster prod --artifact sql.html          # stage mode: no node egress needed
# verify only, any time:
./deploy/install.sh --ch-host ch1.example.com --ch-user asb_verify <same-oauth-flags> --cluster prod \
  --artifact sql.html --verify-only
```
`<same-oauth-flags>` means exactly the `--client-id`, `--issuer`, `--audience`, `--ch-auth` values used at
install time: `sql-config.json`'s expected hash is rendered from them, so any difference is reported as a
mismatch.
Then add the rendered `dist/http_handlers.xml` to `config.d/` on every node and reload (section 5).

### (b) HTTPS only (`--transport http --secure`) **[tested over HTTP; TLS not run against a live server]**

```bash
./deploy/install.sh --ch-host ch.example.com --ch-user asb_deploy \
  --client-id <oauth-client-id> --cluster prod --artifact sql.html \
  --transport http --secure                  # port 8443; add --http-port N if different
```
Same statements, over `curl`; the credentials travel in a 0600 header file. Failures are checked with
`wait_end_of_query=1`: a ClickHouse failure can arrive as HTTP 200 with an `__exception__` trailer, which the
installer treats as an error. Do the same in your own scripts.

Binary-safe single-node upload by hand (the installer's single-node path does the same through its own `curl`)
**[probed: 300 KB random bytes, SHA-256 identical on disk]**:

```bash
curl -sS --data-binary @sql.html -H 'X-ClickHouse-User: asb_deploy' -H @pwheader.txt \
  "https://ch.example.com:8443/?wait_end_of_query=1&engine_file_truncate_on_insert=1&query=INSERT%20INTO%20FUNCTION%20file('sql.html','RawBLOB')%20FORMAT%20RawBLOB"
```
(`pwheader.txt` contains `X-ClickHouse-Key: …`, mode 0600.) This is single node only; for a cluster use the
installer or the manual SQL in the ASSET-DISTRIBUTION appendix.

### (c) Altinity Cloud **[not tested end to end in this repo]**

Assumptions: ACM lets you set a cluster setting named `config.d/sql-browser.xml`, and the cluster has an
interserver `<secret>` (confirm with probe 1.3(d)); the cluster endpoint is HTTPS only.

1. Handlers: `./deploy/install.sh --dry-run --client-id <id> --issuer <issuer> --artifact sql.html` renders
   `dist/http_handlers.xml` (from a checkout with a build, `--artifact` may be omitted). In ACM add it as the
   cluster setting `config.d/sql-browser.xml` and push. Whether ACM limits the size of a pushed setting, and
   that a direct ConfigMap edit is reconciled away, are **[unverified]**: check on your plan.
2. Find the cluster name: `SELECT DISTINCT cluster FROM system.clusters;` on the endpoint you connect to. Use
   that literal name for `--cluster`; do **not** pass the `{cluster}` macro (rejected).
3. Bytes, through the cluster endpoint (the load balancer picks one node; fan-out then happens server-side, so
   no per-pod access is needed). Behind a load balancer or Service the installer's statements may land on
   different pods, so a ~2 MB `_asb_stage_*` copy can remain on a pod that was not the last one used; it is
   never served, and can be emptied as described in ASSET-DISTRIBUTION
   [Failure and retry](ASSET-DISTRIBUTION.md#failure-and-retry):
   ```bash
   ./deploy/install.sh --ch-host <cluster>.<env>.altinity.cloud --ch-user asb_deploy \
     --client-id <id> --issuer <issuer> --cluster <name> --artifact sql.html \
     --transport http --secure
   ```
4. Check every node: the installer prints the per-node table; re-run with `--verify-only` (plus the same
   OAuth flags as the install, see 1.3(f)) after any scale-out or node replacement. Redirect URI and checks:
   section 5.

If your plan forbids `config.d` pushes or SQL file writes, this does not apply: use the container image or Helm
chart.

### (d) clickhouse-operator **[not tested end to end in this repo]**

Handlers go in the ClickHouseInstallation. The key convention was **checked against the operator's own
examples and docs** (`docs/chi-examples/05-settings-05-files-nested.yaml`,
`docs/custom_resource_explained.md`, `docs/chi-examples/21-secure-cluster-secret-01-auto.yaml`): entries of
`spec.configuration.files` are rendered into a ConfigMap and mounted into the pod; a key with the `config.d/`
prefix (or a bare name, which goes to the common config directory) lands in `config.d`. Operator versions
differ, so confirm on yours (the effective file appears under `/etc/clickhouse-server/config.d/` in the pod).

```yaml
spec:
  configuration:
    clusters:
      - name: prod
        secret:
          auto: "True"            # operator-generated interserver <secret>; or use plaintext / secret-ref
        layout: { shardsCount: 2, replicasCount: 2 }
    files:
      config.d/sql-browser.xml: |
        <clickhouse>
          <http_handlers>
            … the <rule> elements from dist/http_handlers.xml …
          </http_handlers>
        </clickhouse>
```
That is, paste the **whole rendered file** minus its `<?xml?>` line, indented under the key, with **no extra
wrapper**: the file already has the single `<clickhouse>` root shown above.
Do **not** put `sql.html` here: the ConfigMap cap is 1 MiB and the artifact is about 2 MB.

`secret.auto` (or a plaintext / secret-ref `secret`) is what lets `clusterAllReplicas` authenticate between
pods; the deploy user must exist on every pod (CHI `users` / `users.d` entry or replicated access storage;
**[untested]**). Then run the installer through the Service / load balancer, stage mode, HTTP(S) or native:

```bash
./deploy/install.sh --ch-host <service-or-lb-host> --ch-user asb_deploy --client-id <id> \
  --cluster prod --artifact sql.html
```
Stage mode fans out server-side over the interserver connection, so pods need not be individually reachable
and need no egress. Behind a Service or load balancer the installer's statements may land on different pods,
so a ~2 MB `_asb_stage_*` copy can remain on a pod; it is never served (how to empty it: ASSET-DISTRIBUTION
[Failure and retry](ASSET-DISTRIBUTION.md#failure-and-retry)). Whether a `files` change needs a pod restart depends on the operator and the setting: check with section 5.

## 4. Topology procedures

- **Fresh install:** run the install once with `--cluster` (or no `--cluster` on a single node). The run is
  two-phase: every node's `_asb_next_*` copy is verified byte-exact before any live file is touched.
- **Upgrade the SPA:** run it again with the new `--artifact`. Each node ends on the old or the new version, never
  an empty or partial file **[tested, including a node killed mid-run]**.
- **Scale-out or node replacement:** a new replica's `user_files/` is empty. Re-run the install (it repairs
  any node); to find out first, run `--verify-only` (with the same OAuth flags as the install) or probe 1.3(f): the empty node shows `len = 0`. Also make sure
  the new node got the `http_handlers` fragment (your config channel should do it), the `<secret>`
  and the deploy user **[wipe + repair tested; a truly new pod is the same state]**.
- **A node was down during a run:** the installer fails after `--ddl-timeout` and the queued DDL replays when
  the node returns, against whatever source exists then. Bring the node back, **re-run** the installer; do not
  wait for the replay.
- **Retry:** every step is idempotent. On any failure fix the cause and re-run the same command. Leftover
  `_asb_t_*` tables are pre-cleaned by the next run; a stale `_asb_stage_<token>.html` after a hard kill is only
  a never-served copy (how to empty it: ASSET-DISTRIBUTION "Failure and retry").
- **Concurrency is unsupported:** one installer or uninstaller at a time per cluster (no lock).
- **Uninstall:** `deploy/uninstall.sh` empties the files on every node; remove the `http_handlers` fragment and
  reload to really disable the route (a 0-byte file serves 200 with an empty body, a missing one 500).

## 5. Enable and verify the handlers

1. Render: `./deploy/install.sh ...` writes `dist/http_handlers.xml` with the CSP `connect-src` filled in from
   your issuer's OIDC discovery (`--dry-run --artifact sql.html` renders without contacting ClickHouse; from a checkout with a build,
   `--artifact` may be omitted). Deploy **that** file, not
   the committed Google default, unless you use Google.
2. Install it through your channel (section 1.1 question 1), on **every** node, and reload. Each rule has a
   unique `name=` attribute; keep it.
3. Register the OAuth redirect URI that the installer prints, e.g. `https://<host>:8443/sql`. It must match the
   origin exactly, **including the port** unless it is 443/80; use the externally exposed host/port if a load
   balancer or ingress fronts ClickHouse.
4. Check, expecting `200`, the right `content-type` and (for `/sql`) the CSP:
   ```bash
   curl -s -D - -o /dev/null https://<host>:8443/sql | grep -iE '^(HTTP|content-type|content-security-policy|cache-control)'
   curl -s -D - -o /dev/null https://<host>:8443/sql/config.json | grep -iE '^(HTTP|content-type)'
   curl -s  https://<host>:8443/sql/config.json     # issuer + client_id only
   ```
   Use a GET-based header dump as shown, not `curl -I`: the rules are `<methods>GET</methods>`, and a `HEAD`
   request to `/sql` returned `404` on 26.3.18.32 **[probed]**, which looks like a missing fragment. `/sql` is `text/html; charset=UTF-8`; `config.json` is `application/json; charset=UTF-8`. A `500` means the
   handler exists but the file is missing on that node; a `404` or the ClickHouse default page means the
   fragment did not load. Behind a load balancer, repeat until you have hit every node, or rely on the
   per-node table from the installer (a single `/sql` smoke test proves one node at most).
5. Sign in at `/sql` and run `SELECT currentUser()`: it must return your identity, not a static user. If
   sign-in works but queries are `401`, ClickHouse does not accept the JWT yet:
   [CLICKHOUSE-OAUTH.md](CLICKHOUSE-OAUTH.md) (token processor) or
   [CLICKHOUSE-OSS-OAUTH.md](CLICKHOUSE-OSS-OAUTH.md) (delegated verifier, `--ch-auth basic`).

**`sql-config.json` is public.** The browser fetches it before any login; it must hold only `issuer`,
`client_id` and the other non-secret fields. A `client_secret`, if your IdP forces one, is exposed to every
visitor: lock the redirect URI and read [LOGIN-SCREEN.md](LOGIN-SCREEN.md) first. Never put a ClickHouse
password or token in it.

## 6. Alternative: Option B (Replicated table + `predefined_query_handler`)

Described, not built or tested. Store the bytes in a `ReplicatedMergeTree` table and serve them with a
`predefined_query_handler` running `SELECT argMax(content, updated) FROM asb_assets WHERE name = 'sql.html'
FORMAT RawBLOB`. Limits: the unauthenticated `/sql` GET runs as whatever `anonymous` resolves to, so that user
needs a read grant on the assets table (the one thing the static approach avoids); replication covers the
replicas of **one shard**, so a multi-shard cluster needs the table on each shard; the Keeper path is
cluster-specific. Its advantage is that replicas added later receive the bytes without a re-run. Details:
[ASSET-DISTRIBUTION.md](ASSET-DISTRIBUTION.md#b-store-the-asset-in-a-replicated-table--predefined_query_handler).
