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
  `AGENTOPS_WORKSPACE_ROOT`／`AGENTOPS_STORE_ROOT`／`AGENTOPS_SYSTEM_DIR`。DB へ複製せず起動時に `resolveContainerPaths`
  で解決し、relative／Mac home path を fail-closed 拒否する。これらは**宣言された**container-neutral root であり、
  現行 TypeScript bootstrap は既に `process.cwd()=/app` で container-neutral。workspace／store をこの root 上へ移す実際の
  配線は DB／volume 化に合わせて consumer が段階採用する（#12/#14）。
- **DATA-container-runtime-005 grounded evidence artifact** — `scripts/runtime-smoke.ts` が出力する JSON 証跡
  （`runtime`・`ok`・`preflight`・`steps`）。監査・PR 添付用の一時 artifact であり SoT ではない。
