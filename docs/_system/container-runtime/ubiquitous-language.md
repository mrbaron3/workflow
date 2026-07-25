# ユビキタス言語 — container-runtime コンテキスト

> container-runtime は、標準 OCI アプリケーションイメージと、Apple Container 等の**コンテナ**ランタイム操作を、
> OS 非依存の core から adapter 境界で隔離する。非決定な**AI**呼出しを扱う `agent-runtime` とは別境界であり、
> 共有するのは "runtime" の語だけ。採点意味論・queue・liveness は所有しない。追加のみ
> （`LANG-container-runtime-NNN` は安定）。

| ID | 用語 | 意味 |
| --- | --- | --- |
| LANG-container-runtime-001 | Container Runtime | OCI コンテナを build/run し network/volume を管理する engine（Apple Container・docker・podman 等）。agent-runtime の Provider とは別軸。 |
| LANG-container-runtime-002 | Container Runtime Adapter | runtime-neutral な `ContainerRuntime` port を特定 CLI の argv／出力へ翻訳する実装。Apple Container 固有挙動はこの adapter だけに閉じる。 |
| LANG-container-runtime-003 | Standard OCI Image | Apple Container 専用形式でない標準 OCI のアプリイメージ。docker/podman/Apple Container で同一に build/run できる。 |
| LANG-container-runtime-004 | Runtime Preflight | 起動前に runtime capability（CLI・version・arch・service・network・volume・image）を fail-closed で検査した構造化 verdict。捏造 pass を出さない。 |
| LANG-container-runtime-005 | Runtime Role | control／runner／postgres の隔離役割。publish 不変条件の key。 |
| LANG-container-runtime-006 | Publish Surface | Mac へ publish される host port の集合。control の loopback port だけが許容される。 |
| LANG-container-runtime-007 | Publish Invariant | 「control の 127.0.0.1 port だけが Mac へ publish され、runner／postgres は内部 network からのみ到達可能」という不変条件。静的（desired）と grounded（running）で二重に接地する。 |
| LANG-container-runtime-008 | Container-Neutral Path | コンテナ絶対かつ設定可能で、Mac home（`/Users`）に依存しない path。grader／workspace／systemDir をこれで解決する。 |
| LANG-container-runtime-009 | Host-Path Dependency | build/runtime surface に hardcode された Mac 絶対 path。scanner が fail-closed で検出する回帰対象。 |
