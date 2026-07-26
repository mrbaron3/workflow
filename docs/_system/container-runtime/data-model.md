# データモデル — container-runtime コンテキスト

> このコンテキストは**永続実体を持たない**。構造化正本は `src/runtime/schema.ts` の runtime-neutral な Zod 契約。
> 各 id は [ADR-0011](../../decisions/ADR-0011-standard-oci-image-and-container-runtime-adapter.md)（AC-CISO-011）を
> 根拠とする。

- **DATA-container-runtime-001 非永続コンテキスト** — preflight／topology／capability は起動ごとに計算する揮発値で、
  `.harness/db.json` へは書かない。runtime capability を DB へ推測保存せず、要求ごとに解決して不足を顕在化する。
- **DATA-container-runtime-002 runtime-neutral 契約** — cross-boundary 語彙は `src/runtime/schema.ts` の Zod schema:
  `TopologySpec`・`ContainerSpec`・`PortPublication`・`VolumeMount`・`NetworkSpec`・`VolumeSpec`・`CapabilityReport`・
  `PreflightReport`／`PreflightCheck`・`PublishInspection`・`ContainerNeutralPaths`。生の内部表現でなくこの契約で会話する。
- **DATA-container-runtime-003 image build descriptor** — `deploy/Containerfile`（＋ `.dockerignore`）が標準 OCI
  イメージの宣言的定義。Apple 専用構文を持たず、`deps → build → runtime` の再現可能な multi-stage seam。
- **DATA-container-runtime-004 container-neutral paths config** — 環境変数 `AGENTOPS_APP_ROOT`／
  `AGENTOPS_WORKSPACE_ROOT`／`AGENTOPS_STORE_ROOT`／`AGENTOPS_SYSTEM_DIR`。DB へ複製せず起動時に解決し、relative／
  Mac home path を fail-closed 拒否する。`AGENTOPS_APP_ROOT` は CLI bootstrap（`resolveHarnessRoot`）が実際に消費し、
  Store／workspace／systemDir がこの root に anchor する（env 未設定時は `process.cwd()` ＝ 現挙動を保存）。
  残りの WORKSPACE／STORE root は、workspace／store を専用 volume へ移す consumer が `resolveContainerPaths` を採用して
  段階配線する（#12/#14）。いずれも macOS 依存を持たない。
- **DATA-container-runtime-005 grounded evidence artifact** — `scripts/runtime-smoke.ts` が出力する JSON 証跡
  （`runtime`・`ok`・`preflight`・`steps`）。監査・PR 添付用の一時 artifact であり SoT ではない。
- **DATA-container-runtime-006 runner isolation input** — worker ID、private mount、empty publish集合、
  DB/GitHub/選択providerだけのoutbound集合。起動時だけ解決し、credential値は永続化しない。
- **DATA-container-runtime-007 agentopsctl actual status** — Apple Container capability、3 roleのstate/network/
  publish/socket/mount/read-only/capabilityとloopback probeを起動ごとに観測する揮発snapshot。persisted lifecycleとは
  同一視せず並べて表示する。
- **DATA-container-runtime-008 credential volume and broker configuration** — runner-only named credential volume、
  private`auth.json` destination、固定monitor repositoryを起動時specへ含める。source host path、credential値、
  fingerprintはstatus/evidenceへ永続化しない。
