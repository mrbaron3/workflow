# ドメインモデル — container-runtime コンテキスト

> 語彙は [ubiquitous-language.md](ubiquitous-language.md) を参照する。各 id は
> [ADR-0011](../../decisions/ADR-0011-standard-oci-image-and-container-runtime-adapter.md)（AC-CISO-011）を根拠とする。
> 追加のみ。

## エンティティ／値オブジェクト

- **DOM-container-runtime-001 TopologySpec** — 集約ルート。1つの内部 network、その永続 volume 群、その上の
  container 群（`LANG-container-runtime-005/006/007`）。publish 不変条件の検査対象。
- **DOM-container-runtime-002 ContainerSpec** — role／name／image／network／publish／volumes／env／workdir／command を
  持つ runtime-neutral な値オブジェクト。adapter が特定 CLI の argv へ翻訳する（生 argv を core が書かない）。
- **DOM-container-runtime-003 RuntimeRole** — control／runner／postgres の列挙。control だけが publish を持てる。
- **DOM-container-runtime-004 CapabilityReport / PreflightReport** — capability は非 mutating な観測（available・version・
  arch・service）、preflight は required check の全成立でだけ `ok` になる fail-closed verdict。

## 不変条件

- **DOM-container-runtime-005 control-only loopback publish** — control の publish は `hostIp=127.0.0.1` のみ、
  runner／postgres の publish は空、全 container は単一の内部 network に属する。違反は起動前に fail-closed で拒否する。
- **DOM-container-runtime-006 fail-closed capability** — 不足した capability（CLI/service/version/arch/network/volume/
  image）は構造化理由で拒否する。部分起動も、代替テストでの押し切りも、捏造 pass もしない。
- **DOM-container-runtime-007 adapter fidelity** — adapter は中立 spec の verb・publish・volume・env・command を
  runtime 固有 argv へ完全に写す。未対応 runtime を別 runtime へ fallback しない。macOS/launchd/Apple Container 固有を
  port 上へ出さない。
- **DOM-container-runtime-008 container-neutral resolution** — 解決される path はコンテナ絶対／設定可能で、Mac home
  （`/Users`）依存を持たない。build/runtime surface の hardcoded host path は回帰検査で fail-closed に検出する。
- **DOM-container-runtime-009 Runner Isolation Boundary** — nonroot process、private named volume、zero publish、
  minimal credential env、explicit outbound集合を一体で検証する起動時aggregate。
- **DOM-container-runtime-010 Managed Resource** — ownership labelとsafe nameを持つnetwork/volume/container。
  adapterは同名foreign resourceを変更しない。
- **DOM-container-runtime-011 Actual Topology** — persisted modeと独立に観測されるcontrol/runner/PostgreSQLの実状態。
- **DOM-container-runtime-012 Compensation Scope** —1回のstartが作成・置換したcontainer集合。失敗時削除範囲の上限となる。
- **DOM-container-runtime-013 Runner Credential Boundary** — GitHub monitor credentialとprovider credentialをrunnerだけに
  所有させ、control/host mount/argv/logから隔離するaggregate。
