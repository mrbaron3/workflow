# 決定記録 0005: skill / コード分担と Agent Skill 梱包方針

- 状態: 確定
- 最終更新: 2026-06-18
- 影響モジュール: M20 オーサリング層 / M21 Design Planner / M22 Design Reviewer / M05 Issue Contract Planner /
  M03 Coordinator / M06 Generator / M07 Evaluator / M09 Harness / 全 LLM 役の実装
- 正本差分: ADR-0001 D19「skill 駆動」を**更新**（§5）。REQUIREMENTS.md への上書きなし

## 1. 背景

本ハーネスの各役は最終的に **Claude Code の Agent Skill** として実装される。しかし ADR-0003 D28（薄い実装層・
厳格さはコードで強制）と ADR-0001 option 2（オーサリングは「AI 補助 + コード強制」）で既に決めたとおり、
**全てが skill になるわけではない**。判断する役は skill、機械が守る部分はコードである。実装に入る前に
「どれを skill にし、どれをコードにするか」と「skill の梱包方針」を固定し、各モジュール仕様の実装が
ばらつかないようにする。

Agent Skill のベストプラクティス（[skills docs](https://code.claude.com/docs/en/skills.md) /
[agentskills.io](https://agentskills.io/specification)）は、偶然にも本ハーネスの薄い実装層方針と一致する
（薄い SKILL.md ＋ 確定性は同梱スクリプトへ）。これを梱包方針として採用する。

## 2. 確定した決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D36 | **skill / コード分担**: 判断（裁量・自然言語・設計著述・整合審査）を行う役は **Agent Skill**。被覆/整合/採番・drift・resolve・状態機械・grader 実行などの**決定的処理は共有コード**（skill でない）。分担表は §3 | 「Coordinator はコード」「厳格さは validation で強制」（ADR-0003 D28）。判断は能力あるモデル、決定性はコードが担うのが両者の強み |
| D37 | **決定的処理は1つの共有ライブラリに集約**し、skill の `scripts/` と Coordinator コードの**両方がそれを呼ぶ**（各 skill に重複実装しない）。`fingerprint()`（M20↔M05 共有）・AC-ID lint・resolve・設計決定的 tier・grader をライブラリ化 | DRY。検証ロジックを skill プロンプトに散らすと drift し、決定性が崩れる。1か所に置けば監査・テストが効く |
| D38 | **skill 梱包方針**: 薄い `SKILL.md`（≤500 行・本文は「何をするか」のみ・繰り返しトークンコストを意識）＋ progressive disclosure（詳細は `references/`、確定処理は `scripts/`、テンプレート/スキーマは `assets/`）＋ trigger 豊富な `description`（≤1024 字・「機能」＋「いつ使うか」）。§4 | ベストプラクティスと薄い実装層方針が一致。本文に rubric/手順を焼き込むと能力あるモデルの品質を下げ陳腐化する（D26/D28） |
| D39 | **独立性が要る審査役（設計審査役・評価役）は分離コンテキストで起動**（`context: fork` / 別サブエージェント）。著者の文脈を共有しない。Coordinator コードが dispatch する | 自己評価の排除（ADR-0002）。独立性を「別 skill」でなく「分離実行」で機械的に担保する |
| D40 | **skill 分割基準**: 責務が異なる / 発動トリガーが独立 / 必要ツール権限が大きく違う → 別 skill。同一責務の内部差異は**バンドル参照ファイル**（`references/`）に留め skill を増やさない | 過分割は description 衝突と保守コスト。Claude Code 標準 skill も「単一 skill ＋ 大量の参照/スクリプト」構成 |

## 3. 分担表（役 → skill / コード）

| 役 / 処理 | 形態 | 同梱・呼び出すコード |
| --- | --- | --- |
| オーサリング補助（M20） | **skill** | `assets/feature-spec.md`・`acceptance.yaml` テンプレ。`scripts/` から **AC-ID lint**（採番・被覆双方向・renumber 禁止・manual 不在）と `fingerprint()` を呼ぶ |
| 設計立案役（M21） | **skill** | 三層設計を著す。`scripts/` から設計**決定的 tier**（被覆/排他・ID 安定・additive・参照実在・DAG・名前衝突・埋め込み禁止）を呼んで自己チェック |
| 設計審査役（M22） | **skill・分離実行（D39）** | 著者と文脈非共有。`scripts/` から決定的 tier を再検査。整合審査は LLM 判断（薄い rubric） |
| 契約 resolve（M05） | **コード** | resolve（join/copy → IssueContract）・schema validation・drift gate・`fingerprint()`。LLM を持たない純関数 |
| 進行管理役（M03 Coordinator） | **コード** | 状態機械・ラベル排他・ロック・worktree・dispatch・DAG 消費。skill を起動する側 |
| 実装役（M06 Generator） | **skill / agent** | IssueContract → PR。worktree・CLI adapter はコード |
| 評価役（M07）＋ ハーネス（M09） | **skill（評価）・分離実行 ＋ コード（grader 実行・隔離環境）** | grader の実コマンド実行・evidence・scorecard 構造化はコード |
| 共有決定的ライブラリ | **コード** | `fingerprint()` / AC-ID lint / resolve / 設計決定的 tier / grader。skill と Coordinator が共に呼ぶ（D37） |

> 原則: **skill は「ゴール＋契約形＋red line」の薄さに保ち、厳格さは呼び出す共有コードに置く**。skill が
> 判断し、コードが守る。

## 4. skill 雛形（梱包の標準形）

ディレクトリ（プロジェクトスコープ `.claude/skills/<name>/`。`<name>` は小文字・ハイフン・ディレクトリ名一致）:

```text
.claude/skills/<role-name>/
  SKILL.md            # ≤500 行・薄い。frontmatter + 「何をするか」+ 契約形 + red line
  references/         # 詳細仕様（オンデマンド読込・1ファイル1トピック）
  assets/             # テンプレート・スキーマ（feature-spec.md 等）
  scripts/            # 確定処理の呼び出し（共有ライブラリの薄いラッパ）
```

`SKILL.md` frontmatter（使用するフィールド）:

```text
---
name: <role-name>                 # 必須・≤64・小文字/数字/ハイフン・ディレクトリ名一致
description: <機能> + いつ使うか    # 必須・≤1024・trigger 豊富
allowed-tools: ...                # 役に必要なツールのみ（最小権限）
# 審査役のみ: 分離実行で独立性を担保（D39）
# context: fork    /    agent: <reviewer-agent>
---
```

本文の書き方（D38・ベストプラクティス）:

- 「何をするか」を述べ、「なぜ/背景」は書かない（読み込み後はセッション中ずっとトークンコスト）。
- rubric・手順の網羅列挙を焼き込まない。判断は列挙ヒントに留めモデルに委ねる。
- 確定処理は `scripts/...` を呼ぶ（プロンプトで手作業させない）。
- 詳細は `references/...` へ相対リンクで逃がす。

## 5. ADR-0001 D19 の更新

ADR-0001 D19「オーサリング層（M20）は skill 駆動の人間ワークフロー（draft-spec skill を拡張/置換）」を
**以下に更新する**（本 ADR が supersede）:

> **新 D19**: オーサリング層は **AI 補助 ＋ コード強制**。人間が WHAT（GWT 受け入れ基準）を著し、AI が補助
> （severity/verification 提案・auto/manual 分類）する。**契約形式・自動採点・AC-ID 整合の強制は決定的コード**
> （AC-ID lint・schema validation）が担う。skill は便利な入口に過ぎず**必須にしない**（特定 skill = draft-spec に
> 縛らない）。テンプレートが著述ガイドを、コードが整合強制を担い、skill 不在でも成立する。

理由: M20 の価値は「協業体験」より「著述物が契約形式・被覆を満たすことの強制」にあり、それはコードが担うべき
（D28）。skill に縛ると薄い実装層から外れる。

## 6. 残 open

- 共有決定的ライブラリの置き場（`src/` 配下のパッケージ構成・skill `scripts/` からの呼び出し方）。実装着手時。
- skill をプロジェクトスコープ（`.claude/skills/`）に置くか、プラグイン（`claude-plugins`）として配布するか。
- 設計審査役・評価役の「分離実行」の具体（`context: fork` か別サブエージェント type か）。M22/M07 実装時。
- 各役 skill の `description`（trigger 文言）と `allowed-tools` の最小集合。各 skill 着手時。
