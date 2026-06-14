# 決定記録 0001: オーサリング層と実行層の分離・spec.md を SoT とする

- 状態: 確定
- 最終更新: 2026-06-14
- 影響モジュール: M02 Hermes / M03 Development Coordinator / M05 Issue Contract Planner /
  M18 Storage・SoT ／ 新設「オーサリング層」（地図未登録, 暫定 M20）
- 正本差分: REQUIREMENTS.md §1.3 を一部上書き（後述 §4）

## 1. 背景

当初の計画には作りたいものが二つ混在していた——**Hermes-agent** と
**Development Department（現コードの Coordinator）**。現行コード（`src/`）は Hermes 導入を
想定せずに書かれており、Coordinator が複数エージェントの責務と「次に何をやるか」の
判断を抱え込んでいた。両者の責務境界と、開発をどの状態から始めるかを棚卸しして確定した。

## 2. 確定した決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D1 | Development Department を先に固め、Department interface は後から抽出する | 抽象は具体の後にしか正しく設計できない。先に interface を切ると偽の汎用性になる。interface への依存は Hermes の routing 一点のみで差し替え安価 |
| D2 | Coordinator は Department 内で実行ループを回し続ける。Hermes は execution を持たない | Hermes の責務（§3）は read 側中心で execution が一つも無い。ループの住処は Hermes に無い。dispatch(駆動) と aggregate(観測) は同じ store を別目的で読むだけで競合しない |
| D3 | 現フェーズの Hermes の実体は「進捗集約」のみ | 5 責務のうち意図分類・契約生成はオーサリング層へ前倒し、部署ルーティングは二部署目まで縮退。実体ある価値は進捗統合だけ。壮大な意図分類 Hermes を今作るのは YAGNI |
| D4 | spec.md を source of truth とする（リポジトリ内・Git 履歴管理） | 仕様をリポジトリに置き Git で履歴管理したい。正本 §1.3「Issue=SoT」を上書き |
| D5 | issue/PR は実行 SoT（spec.md からの派生） | オーサリング SoT（spec.md）と実行 SoT（状態・ラベル・PR）を分離。役割が違う |
| D6 | 合格基準は人間+AI 協業。人間が behavior、AI が verification を提案。エントリ状態 = `contract-approved`（人間が AC に署名） | ブラックボックス生成の承認ではなく共著。承認時点で合格基準は人間のもの |
| D7 | B 方針: spec.md の受け入れ要件は自動採点メソッドのみ。非自動は `manual-requirements.md` に分離し tier 別ルーティング | 原子性・再入防止・マルチシグ等は自動採点不可。緑チェックを偽装せず監査/人間/静的解析へ |
| D8 | issue は契約を埋め込まず `specRef`(path+gitSha) + `acceptanceCriteriaIds` で参照。契約は dispatch 時に resolve する派生物。gitSha 固定で drift 検知 → 再署名フラグ | spec.md=SoT を守り二重管理を排除。drift を構造的に検知 |
| D9 | issue = 承認後の work order。状態機械を「前半(authoring)」「後半(execution)」に割る | 契約オーサリングは issue 投稿より前に終わる。前半は spec.md 上の状態であり issue の状態ではない |
| D10 | 粒度: 1 機能(1 spec.md)=epic、受け入れ要件サブ領域=子 issue(PR サイズ)。Issue Planner が提案 → 人間が投稿時に確認 | 人間の作業単位（機能）を保ちつつ PR サイズへ分解。スライスは協業 |
| D11 | Epic 進捗は Department 所有・Hermes は read-only。進捗 = join(リポジトリのロードマップ, issue/PR 状態) で導出し、保存しない | §3.2 単体動作を守る（Hermes 無しでも部署が自分の進捗を更新可）。保存すると drift する |
| D12 | リリース承認は Department 境界のポリシーとして注入（Hermes 経由=人間承認、単体=auto-approve）。機械的マージは Release Manager に残す | §2.2 未承認の外部公開は対象外。§3.2 単体動作と両立させるためハードコードしない |

## 3. 確定した全体フロー

```text
【オーサリング層 — 人間 + AI 協業（リポジトリ = オーサリング SoT）】
  ① 機能ごとに spec.md を協業作成（受け入れ要件[AC-ID] / manual-requirements.md[MR-ID]）
  ② 機能間の優先順位調整 → ロードマップ（何を・どの順で）
  ③ 人間が AC に署名 → contract-approved → epic:issue を切り出し投稿
       issue 本文 = spec.md ポインタ + AC-ID 参照（埋め込まない）

【実行層 — Development Department（issue/PR = 実行 SoT）】
  ④ Hermes が issue をポーリング → 部署へ振り分け（read 側。今は dev 一択）
       Department 内 Coordinator がループ:
         Generator → PR → Evaluator → Scorecard
                       ↑request_changes │approve
                  Repair Router ◀───────┤
                                         ▼
                                  Release Manager（承認ポリシー注入）
       MR-ID（要審査）→ tier 別に 人間 / 監査 / 静的解析

【統合層】
  ⑤ Coordinator が Epic 進捗を更新（部署所有, Hermes は read-only）
  ⑥ Hermes が join を計算 → 人間へ報告 / Dashboard
  ⑦ 失敗 → Eval Curator → 改善提案
```

## 4. 正本（REQUIREMENTS.md）との差分

各モジュール仕様確定時にこの差分を反映する。

- **§1.3「GitHub Issue / PR を source of truth とする」→ 上書き**。spec.md を
  オーサリング SoT、issue/PR を実行 SoT に分離（D4・D5）。
- **M02 Hermes のスコープ縮小**。意図分類・契約生成はオーサリング層へ移動、
  部署ルーティングは二部署目まで縮退。現フェーズの実体は進捗集約のみ（D3）。
- **M05 / M18: IssueContract を「埋め込み」から「参照」へ**。`Issue.contract`
  （[schema.ts](../../src/domain/schema.ts) L108）を廃し `specRef`+`acceptanceCriteriaIds`
  に置換、契約は dispatch 時に resolve（D8）。
- **地図に無い新層**。spec.md の協業オーサリングは M01〜M19 のどれでもない。
  暫定 **M20「オーサリング層 / spec.md 契約」** として追加を要検討。
- **M11 Release**: auto-merge をやめ、承認ポリシー注入点に置換（D12）。

## 5. 状態機械の新旧差分（M03 で確定）

現行 `ISSUE_STATUSES`（[states.ts](../../src/domain/states.ts) L13）は authoring と
execution が混在。これを分割する。

```text
旧（全て issue 上, 一列）:
  planned → ready-for-contract → contract-drafted → ready-for-generation →
  generation-in-progress → ready-for-evaluation → evaluation-in-progress →
  changes-requested / approved → ready-to-merge → released  (+ needs-human-review)

新・前半（オーサリング層 = spec.md / ロードマップ上。issue 化前）:
  planned → ready-for-contract → contract-drafting(協業) → contract-approved(署名)

新・後半（issue = work order。投稿時に contract-approved で生成）:
  contract-approved(入口) → ready-for-generation → generation-in-progress →
  ready-for-evaluation → evaluation-in-progress →
  changes-requested ⇄ generation-in-progress →
  build-approved → ready-to-release →（人間リリースゲート）→ released
  (+ needs-human-review エスケープ)
```

命名衝突の解消（提案・M03 確定時に最終化）:

- 旧 `approved`（eval 合格）→ `build-approved`（人間署名の `contract-approved` と区別）。
- 旧 `ready-to-merge` → `ready-to-release`（人間リリースゲートを明示）。

## 6. 成果物（このセッション）

- [templates/feature-spec.md](../../templates/feature-spec.md) — Department への入力契約。
  人間が事前作成する spec.md テンプレート（AC-ID / 自動採点メソッドのみ / 金が動く WHAT の AC 昇格）。
- [templates/manual-requirements.md](../../templates/manual-requirements.md) —
  要審査要件票（MR-ID / tier 別: audit / static_analysis / human_review / integration_test）。

## 7. 残課題（open）

- **投影ロジック**: `resolve(spec.md@gitSha, AC-IDs) → IssueContract` と drift 検知の具体化（M05/M18）。
- **Hermes 進捗集約**: join の計算と報告面（Dashboard / レポート）の設計（M02/M13）。
- **実装シーケンス**: 埋め込み契約の参照化・前半状態の分離・auto-merge 廃止をどの順で改修するか。
- **オーサリング層のモジュール化**: M20 として地図に登録するか（README §2 / §7 の更新要否）。
