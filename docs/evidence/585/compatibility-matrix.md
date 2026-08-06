# ClickHouse server / browser compatibility matrix (plan §13/§25)

## Server rows

| Row | Role | Tag | Digest | Executed | Server version | Status |
|---|---|---|---|---|---|---|
| `proposed-oldest-oss` | proposed oldest OSS ClickHouse | 24.8.14.39 | sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b | yes | 24.8.14.39 | failed |
| `proposed-oldest-altinity-stable` | proposed oldest matching Altinity Stable build | 24.8.14.10547.altinitystable | sha256:d0c456453ddc5220bc96e37c9b1f81eb210ca22fc0d6877dc9e71722ff43fa8f | yes | 24.8.14.10547.altinitystable | failed |
| `current-stable-oss` | current stable OSS ClickHouse | 26.6.2.160 | sha256:a63a90ffdcb574683ebfe96e4c53e2dbe401864add7bb06dc244eb935d828e7f | yes | 26.6.2.160 | passed |
| `current-altinity-stable` | current Altinity Stable build | 26.3.16.10001.altinitystable | sha256:8526a7742e6ef707dee68107876b18d45570b0448f284d3c785eb2d2e4417a5e | yes | 26.3.16.10001.altinitystable | passed |
| `cloud` | ClickHouse Cloud | — | — | no | — | not evaluated — no ClickHouse Cloud credentials in this environment |

## Browser / origin matrix

| Row | Origin | Browser | Executed | Status | Failure detail |
|---|---|---|---|---|---|
| proposed-oldest-oss | same-origin | chromium | yes | passed | — |
| proposed-oldest-oss | same-origin | webkit | yes | passed | — |
| proposed-oldest-oss | cross-origin | chromium | yes | passed | — |
| proposed-oldest-oss | cross-origin | webkit | yes | passed | — |
| proposed-oldest-altinity-stable | same-origin | chromium | yes | passed | — |
| proposed-oldest-altinity-stable | same-origin | webkit | yes | passed | — |
| proposed-oldest-altinity-stable | cross-origin | chromium | yes | passed | — |
| proposed-oldest-altinity-stable | cross-origin | webkit | yes | passed | — |
| current-stable-oss | same-origin | chromium | yes | passed | — |
| current-stable-oss | same-origin | webkit | yes | passed | — |
| current-stable-oss | cross-origin | chromium | yes | passed | — |
| current-stable-oss | cross-origin | webkit | yes | passed | — |
| current-altinity-stable | same-origin | chromium | yes | passed | — |
| current-altinity-stable | same-origin | webkit | yes | failed | — |
| current-altinity-stable | cross-origin | chromium | yes | passed | — |
| current-altinity-stable | cross-origin | webkit | yes | passed | — |
