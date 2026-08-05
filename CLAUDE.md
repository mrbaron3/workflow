# Project instructions

AI 組織運用ハーネス。spec は `docs/specs/<feature>/`（`spec.md` ＋ `acceptance.yaml`・to-spec で生成）、
設計判断は `docs/decisions/`（ADR）、境界ごとの system 層は `docs/_system/<ctx>/`（地図は `docs/context-map.md`）、
TypeScript の共有決定的ライブラリは `apps/agentops/src/`、Agent Skill は `.claude/skills/`。

## アプリケーション境界

- Go アプリケーションは `apps/control-plane/`、TypeScript アプリケーションは `apps/agentops/` に置く。
  repository root にアプリケーション source directory を再導入しない。
- `db/` と `contracts/` は両アプリケーションが利用する language-neutral な共有境界、`deploy/` は
  両アプリケーションと PostgreSQL を組み立てる統合層である。どちらか一方のアプリケーションへ所有させない。
  `provider-cli`・`gh`・`gosu`のようなimage構成専用toolは`deploy/tools/`に置く。
- Go↔TypeScript の durable business coordination は PostgreSQL `agentops_control` を正本とする。ただし
  credential broker HTTP、CONNECT egress proxy、runner shared volume、`agentopsctl` container lifecycle操作は
  別のsecurity/runtime境界であり、DB message として偽装しない。lifecycle mode/drain fence自体はDBへdurableに残す。
- directory は分離するが、schema version/checksum の exact gate と lifecycle orchestration があるため、
  当面の release unit は repository 全体で一体とする（ADR-0021）。独立 deploy compatibility を暗黙に主張しない。

## このファイルの方針（決定論はコードへ）

- **CLAUDE.md には理解を要する規約・判断だけ**を書く。lint・同期・配線などの**決定論的/機械的な手続き**は
  hook / script / CI に置き、使用箇所で自己説明させる。毎セッション読み込みの CLAUDE.md に自明な手順を
  書かない（コンテキストの無駄）。

## Issue / PR 著述規約

- GitHub の issue と PR は**日本語で書く**（タイトル・本文とも。識別子・enum 値・コード片は原文のまま）。
- **PR は元 issue と紐づける**。その PR だけで元 issue の作業が完了する場合は、マージで閉じる
  `Closes <owner>/<repo>#<番号>` を本文に書く（GitHub の閉鎖キーワードは英語のみ有効）。
  1つの元 issue を複数 PR に分割した場合、各途中 PR は `Refs <owner>/<repo>#<番号>` とし、
  全 work unit の完了を確認する集約点だけが元 issue を閉じる。ハーネス生成の gate PR は
  `renderGatePrBody` が intake の Source Snapshot と分割数から自動で選ぶ。手書きの PR も同様にする。

## Agent Skill 著述規約

新しい skill を作る / 既存 skill を編集するときは必ず守る。

- **Anthropic の最新の公式ベストプラクティスに沿う**（[skills docs](https://code.claude.com/docs/en/skills.md)）。
  記憶に頼らず着手時に最新版を確認し、本節の規約もそれに整合させる（乖離したら本節を更新する）。
- **正本は `SKILL.md`**。ただし**必ず日本語訳 `SKILL.md.ja` を併設し、`SKILL.md` を変更したら同時に
  `SKILL.md.ja` も更新する**（同期を保つ）。`.ja` は人間向けで Claude Code はロードしない。
- **`SKILL.md` の frontmatter `description` は日本語**で書く（トリガー文言を日本語の依頼に合わせる）。
  本文は英語でよい。
- **相対パスで skill の外へ登らない**（`../` で外に出ない）。skill の外のリポジトリ資源は **root 相対パス**
  （例: `docs/roadmap.yaml`）で参照する。**skill 自身がバンドルする資源は skill 相対パスで参照する**
  （自己完結・可搬性のため）: `assets/` の出力テンプレ（例: `assets/feature-spec.md`）、および `scripts/` から
  `scripts/lib/` の **vendored lib**（例: `./lib/design-lint.js`）。skill の script は実行時に
  `apps/agentops/src/` を読まない。
- skill は薄く保つ。rubric/手順を焼き込まず、確定処理は `scripts/`（共有ライブラリの薄い
  ラッパ）に委譲し、詳細は `references/` に逃がす。

## 資源の住処

- **TypeScript アプリケーション内で共有する契約の正本は zod**
  （`apps/agentops/src/domain/schema.ts` の契約 ＋ `states.ts` の状態機械）とする。
  かつて root `templates/` に置いていた雛形（`issue-contract.md`・`scorecard.yaml`・`labels.yaml`・
  `roadmap.yaml`・`epic.md`）は zod が SSOT になった時点で二重管理になり、実際に status 分類が
  `states.ts` と乖離したため廃止した（ADR-0002）。**root `templates/` を再導入しない。**
- **単一 skill だけが使うテンプレ**は、その skill の `assets/` を単一住処として持つ（複製でなく**移設**。
  例: `to-spec` の `assets/feature-spec.md`・`assets/acceptance.yaml`）。
- **共有決定的ライブラリ**（`fingerprint` / lint / resolve 等）は
  **`apps/agentops/src/` に単一ソース**を置く（重複実装しない）。進行管理役はこの source を直接呼び、
  **skill へは vendor して自己完結**させる（手で複製
  しない・実行時に外部を import しない）。vendored lib ＋ `assets/` テンプレで配布可能プラグインへ切り出せる。

## テスト / lint

- TypeScript: `npm test`（vitest）、`npm run typecheck`。Go: `npm run go:test`
  （または `go test ./apps/control-plane/...`）。root command は workspace router であり、
  application source の混在を意味しない。
