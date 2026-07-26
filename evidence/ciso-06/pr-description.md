# CISO-06 PR description

## 概要

CISO-06として、短命なGo CLI `agentopsctl start|drain|stop|status|logs|open`を追加し、Apple Container上の
control・runner・PostgreSQLをPostgreSQL権威のOFF／MONITOR_ONLY／ACTIVE／DRAININGで操作できるようにします。

## 主要変更

- schema version 4へlifecycle singleton、semantic-bound idempotent/audited transition、drain deadline/timeout/errorを追加
- DRAINING commitとdelivery routing／poll・webhook enqueue／job lease／direct INSERT triggerを同一row lockで原子的にfence
- actual container/lease/attemptを照合するrestart recoveryと、mutation receipt＋safe-mode rollbackによるpartial-start compensation
- ownership検証付きApple Container adapter、exact loopback-only control publish、internal-only runner/PostgreSQL
- immutable image descriptorとenvironment/init/security/network/mount/publicationのcanonical specで`--build`／driftをreconcile
- runner direct egressをhost-only networkで拒否し、control CONNECT proxyでGitHub／GitHub API／選択providerの443だけ許可
- read-only root、capability drop、private named volume、credential/DB role分離、argv/error redaction
- unit／race／real PostgreSQL concurrency／full TypeScript／actual Apple Container lifecycle・publish・egress smoke

## 検証

- `mise exec go@1.24.0 -- go test -race ./...`
- `mise exec go@1.24.0 -- go vet ./...`
- `npm test`
- `AGENTOPS_TEST_DATABASE_URL=<temporary-loopback-postgres> npm run test:postgres`
- `AGENTOPS_TEST_DATABASE_URL=<temporary-loopback-postgres> npm run test:dashboard`
- `npm run build`
- `npm audit --audit-level=high`
- Apple Container 1.1.0/arm64でACTIVE→DRAINING→OFF、idempotent replay、DRAINING recovery、
  MONITOR_ONLY volume restart、repeated stop、partial-start compensation、ACTIVE `--build` reconciliation、
  non-expired in-flight drain、exact publish/security inspect、allowed/denied CONNECTを実測

証跡: `evidence/ciso-06/`

Closes mrbaron3/workflow#16
