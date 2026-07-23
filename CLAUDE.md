# Project instructions

AI 組織運用ハーネス。仕様の下書き（draft・正式 spec は to-spec で生成）は `draft/_spec/`（地図は `draft/_spec/README.md`、決定は `draft/_spec/decisions/`）、
共有決定的ライブラリは `src/`、Agent Skill は `.claude/skills/`。

## このファイルの方針（決定論はコードへ）

- **CLAUDE.md には理解を要する規約・判断だけ**を書く。lint・同期・配線などの**決定論的/機械的な手続き**は
  hook / script / CI に置き、使用箇所で自己説明させる。毎セッション読み込みの CLAUDE.md に自明な手順を
  書かない（コンテキストの無駄）。

## Issue / PR 著述規約

- GitHub の issue と PR は**日本語で書く**（タイトル・本文とも。識別子・enum 値・コード片は原文のまま）。
- **PR は元 issue と紐づけ、マージで issue が閉じる**ようにする（本文に `Closes <owner>/<repo>#<番号>`。
  GitHub の閉鎖キーワードは英語のみ有効）。ハーネス生成の gate PR は `renderGatePrBody` が intake の
  Source Snapshot から自動で付す。手書きの PR も同様にする。

## Agent Skill 著述規約

新しい skill を作る / 既存 skill を編集するときは必ず守る。

- **Anthropic の最新の公式ベストプラクティスに沿う**（[skills docs](https://code.claude.com/docs/en/skills.md)）。
  記憶に頼らず着手時に最新版を確認し、本節の規約もそれに整合させる（乖離したら本節を更新する）。
- **正本は `SKILL.md`**。ただし**必ず日本語訳 `SKILL.md.ja` を併設し、`SKILL.md` を変更したら同時に
  `SKILL.md.ja` も更新する**（同期を保つ）。`.ja` は人間向けで Claude Code はロードしない。
- **`SKILL.md` の frontmatter `description` は日本語**で書く（トリガー文言を日本語の依頼に合わせる）。
  本文は英語でよい。
- **相対パスで skill の外へ登らない**（`../` で外に出ない）。skill の外のリポジトリ資源は **root 相対パス**
  （例: `templates/labels.yaml`）で参照する。**skill 自身がバンドルする資源は skill 相対パスで参照する**
  （自己完結・可搬性のため）: `assets/` の出力テンプレ（例: `assets/feature-spec.md`）、および `scripts/` から
  `scripts/lib/` の **vendored lib**（例: `./lib/design-lint.js`）。skill の script は実行時に `src/` を読まない。
- skill は薄く保つ。rubric/手順を焼き込まず、確定処理は `scripts/`（共有ライブラリの薄い
  ラッパ）に委譲し、詳細は `references/` に逃がす。

## 資源の住処

- **テンプレート**は原則 root `templates/` を**単一の住処**とする（skill 配下に複製しない）。ただし
  **単一 skill だけが使うテンプレ**は、その skill の `assets/` を単一住処として持ってよい（複製でなく**移設**。
  例: `to-spec` の `assets/feature-spec.md`・`assets/acceptance.yaml`）。コードや複数 consumer が共有する
  テンプレ（`labels.yaml`・`roadmap.yaml`・`issue-contract.md`・`scorecard.yaml`・`epic.md` 等）は root に置く。
- **共有決定的ライブラリ**（`fingerprint` / lint / resolve 等）は **`src/` に単一ソース**を置く（重複実装
  しない）。進行管理役は src を直接呼び、**skill へは vendor して自己完結**させる（手で複製
  しない・実行時に外部を import しない）。vendored lib ＋ `assets/` テンプレで配布可能プラグインへ切り出せる。

## テスト / lint

- テスト: `npm test`（vitest）。型: `npm run typecheck`。
