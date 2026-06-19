# Project instructions

AI 組織運用ハーネス。仕様の下書き（draft・正式 spec は to-spec で生成）は `draft/_spec/`（地図は `draft/_spec/README.md`、決定は `draft/_spec/decisions/`）、
共有決定的ライブラリは `src/`、Agent Skill は `.claude/skills/`。

## Agent Skill 著述規約

新しい skill を作る / 既存 skill を編集するときは必ず守る。

- **正本は `SKILL.md`**。ただし**必ず日本語訳 `SKILL.md.ja` を併設し、`SKILL.md` を変更したら同時に
  `SKILL.md.ja` も更新する**（同期を保つ）。`.ja` は人間向けで Claude Code はロードしない。
- **`SKILL.md` の frontmatter `description` は日本語**で書く（トリガー文言を日本語の依頼に合わせる）。
  本文は英語でよい。
- **相対パスを使わない**。`../` で skill の外へ登らない。リポジトリ資源は **root 相対パス**
  （例: `templates/labels.yaml`）または **CWD 起点の絶対パス**（script 内の import は
  `process.cwd()` 起点）で参照する。**例外**: skill 自身がバンドルする資源（`assets/`）は、その skill 内から
  **skill 相対パス**（例: `assets/feature-spec.md`）で参照してよい（配布時の可搬性のため・to-spec で適用）。
- skill は薄く保つ（ADR-0005）。rubric/手順を焼き込まず、確定処理は `scripts/`（共有ライブラリの薄い
  ラッパ）に委譲し、詳細は `references/` に逃がす。

## 資源の住処

- **テンプレート**は原則 root `templates/` を**単一の住処**とする（skill 配下に複製しない）。ただし
  **単一 skill だけが使うテンプレ**は、その skill の `assets/` を単一住処として持ってよい（複製でなく**移設**。
  例: `to-spec` の `assets/feature-spec.md`・`assets/acceptance.yaml`）。コードや複数 consumer が共有する
  テンプレ（`labels.yaml`・`roadmap.yaml`・`issue-contract.md`・`scorecard.yaml`・`epic.md` 等）は root に置く。
- **共有決定的ライブラリ**（`fingerprint` / lint / resolve 等）は `src/` に1つ置き、skill の `scripts/` と
  進行管理役コードが共に呼ぶ（重複実装しない・ADR-0005 D37）。skill 配下に lib をバンドルしない。
- skill 群を配布可能プラグインへ切り出す場合のみ、ビルド済み lib ＋ テンプレを一緒にバンドルする（将来）。

## テスト / lint

- テスト: `npm test`（vitest）。型: `npm run typecheck`。
- `.md` を編集したら `markdownlint` を通す（pre-commit hook 強制）。
