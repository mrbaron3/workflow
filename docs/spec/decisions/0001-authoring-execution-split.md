# 決定記録 0001: オーサリング層と実行層の分離・spec.md を SoT とする

- 状態: 確定
- 最終更新: 2026-06-14（簡易アプリ通し確認による改訂: D2/D3/D10 明確化, D13-D19 追加, O1-O4 解決）
- 影響モジュール: M02 Hermes / M03 Development Coordinator / M05 Issue Contract Planner /
  M21 Design Planner（新規）/ M18 Storage・SoT ／ 新設「オーサリング層」（暫定 M20）
- 正本差分: REQUIREMENTS.md §1.3 を一部上書き（後述 §4）

## 1. 背景

当初の計画には作りたいものが二つ混在していた——**Hermes-agent** と
**Development Department（現コードの Coordinator）**。現行コード（`src/`）は Hermes 導入を
想定せずに書かれており、Coordinator が複数エージェントの責務と「次に何をやるか」の
判断を抱え込んでいた。両者の責務境界・開発の開始状態・粒度を棚卸しし、簡易アプリ
（Todo）で端から端まで通して確認した上で確定した。

## 2. 確定した決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D1 | Development Department を先に固め、Department interface は後から抽出する | 抽象は具体の後にしか正しく設計できない。先に interface を切ると偽の汎用性になる |
| D2 | Coordinator は Department 内で実行ループを回す。**dev 部署（Coordinator）が `contract-approved` の issue を直接ポーリングする**。Hermes は **dispatch 経路に居ない** | §3.2 単体動作。issue を拾うのは部署の責務。Hermes 無しでも部署が自走できる |
| D3 | Hermes の実体は read 側の **進捗集約のみ**（dispatch を持たない） | 5 責務のうち意図分類・契約生成はオーサリング層へ前倒し、部署ルーティングは二部署目まで縮退。execution の住処は Hermes に無い |
| D4 | spec.md を source of truth とする（リポジトリ内・Git 履歴管理） | 仕様を repo に置き Git 管理したい。正本 §1.3「Issue=SoT」を上書き |
| D5 | issue/PR は実行 SoT（spec.md からの派生） | オーサリング SoT（spec.md）と実行 SoT（状態・ラベル・PR）を分離 |
| D6 | 合格基準は人間+AI 協業。エントリ状態 = `contract-approved`（人間が AC に署名） | 共著してから承認。承認時点で合格基準は人間のもの |
| D7 | B 方針: spec.md の受け入れ要件は自動採点メソッドのみ。非自動は要審査票へ分離し tier 別 | 自動採点不可項目（原子性・再入防止等）の緑チェック偽装を防ぐ |
| D8 | issue は契約を埋め込まず `specRef`(path+gitSha) + `acceptanceCriteriaIds` で参照。契約は dispatch 時 resolve。gitSha 固定で drift 検知 → 再署名 | spec.md=SoT を守り二重管理を排除 |
| D9 | 状態機械を二段に割る: **epic（spec.md）ライフサイクル** と **issue（work order）ライフサイクル**（§5） | 契約オーサリング・設計は issue より前。前段は epic の状態 |
| D10 | 粒度（β）: 1 機能(1 spec.md)=**epic**、受け入れ要件サブ領域=分割ヒント、**issue=PR サイズ**。M21/M05 が AC をまたいで PR サイズに導出。**AI が自動スライス、人間 override は任意** | subArea のサイズはバラバラ。1:1 に縛らず PR サイズに揃える。人間の単位は epic まで |
| D11 | Epic 進捗は Department 所有・Hermes は read-only。進捗 = join(リポジトリのロードマップ, issue/PR 状態) で導出し保存しない | §3.2 単体動作。保存すると drift する |
| D12 | リリース承認は Department 境界のポリシー注入（Hermes 経由=人間承認、単体=auto-approve）。機械的マージは Release Manager | §2.2 と §3.2 を両立 |
| D13 | **M21 Design Planner を新設**（AI）。approved spec.md → 詳細設計 + PR サイズ分解。M05 は **resolve（spec の AC + 設計スライス → IssueContract）の機械処理に縮小** | 設計（判断）と契約 resolve（機械）は性質が違い、混ぜるべきでない |
| D14 | 詳細設計を二層化: **Tier1 アーキ・スパイン**（epic・共有・決定のみ・repo に1ファイル）/ **Tier2 設計スライス**（PR サイズ・各 issue が保持）。detailed-design.md は issue に添付せず**分割**する | 1 PR=1 issue に epic 設計は大きすぎる。共有決定だけ epic に残し、コンポーネント詳細を issue へ分配 |
| D15 | （O1 反転）spec.md は **人間可読な AC（id+severity+behavior）** を持つ。`verification`(method+expected) は **別ファイル `acceptance.yaml`**（AC-ID をキー、AI が協業で埋める）。両方 repo 内 | embedded YAML は人間可読性を損なう。behavior=人間向け WHAT、verification=grader 向けで分離 |
| D16 | （可読性前提）detailed-design 以下（Tier1/Tier2/コード）は **AI が著者・人間の routine ループには入らない。ただし人間可読として維持**（MR 監査 / Tier1 任意レビュー / リリース説明責任・保守の3例外が必要時読む） | 「読まない」≠「読めない」。採点可能性と可読性要求は反比例する |
| D17 | （human_review ゲート）特定箇所のみタグで人間に押し出す。出口は **approve** または **層別差し戻し**（WHAT→authoring / アーキ→M21 / コード→repair）。受け皿は既存 `needs-human-review`。トリガは issue の `manualRequirementIds` / Tier1 / release | 人間の「読む義務」を能動監視でなくパイプライン駆動の明示タスクに変換。#5 を保つ |
| D18 | （自動化境界）人間必須以外は全自動。**PR 作成は自動、本番 merge は人間ゲート**（§5 表） | ハーネスの存在意義。create と merge を混ぜない |
| D19 | オーサリング層（M20）は **skill 駆動の人間ワークフロー**として実装（既存 `draft-spec` skill を本合意の出力形に拡張/置換） | サービスではなく協業を駆動する skill |

## 3. 確定した全体フロー

```text
【オーサリング層 M20 — 人間 + AI 協業（リポジトリ = オーサリング SoT）】
  ① spec.md(WHAT: AC=id+severity+behavior) + acceptance.yaml(verification) を協業作成
       非自動要件は manual-requirements.md(MR-ID, tier) へ分離（B 方針）
  ② 機能間の優先順位調整 → ロードマップ
  ③ 人間が AC に署名 → contract-approved（gitSha 固定）

【設計・分解 M21 / M05 — AI】
  ④ M21 Design Planner: 詳細設計（Tier1 スパイン=epic 共有 / Tier2 スライス=PR サイズ）
       + PR サイズへ issue 分解（β）。人間 override は任意
  ⑤ epic:issue を投稿。issue = specRef(path+gitSha) + AC-ID 群 + Tier2 スライス + MR-ID 群

【実行層 — Development Department（issue/PR = 実行 SoT）】
  ⑥ dev 部署の Coordinator が contract-approved の issue を直接ポーリング
       resolve(spec.md@gitSha の AC + 設計スライス) → IssueContract
       Generator → PR → Evaluator → Scorecard
                     ↑request_changes │auto 全 pass
                Repair Router ◀───────┤
                                       ▼
                human_review ゲート（MR/release があれば）→ approve or 層別差し戻し
                                       ▼
                Release Manager（人間リリースゲート）

【統合層】
  ⑦ Coordinator が Epic 進捗を更新（部署所有, Hermes は read-only）
  ⑧ Hermes が join を計算 → 人間へ報告 / Dashboard（dispatch 経路には不在）
  ⑨ 失敗 → Eval Curator → 改善提案
```

## 4. 正本（REQUIREMENTS.md）との差分

- **§1.3「Issue=SoT」→ 上書き**。spec.md=オーサリング SoT、issue/PR=実行 SoT（D4・D5）。
- **M02 Hermes のスコープ縮小**。実体は進捗集約のみ。dispatch 経路に不在（D2・D3）。
- **M05 / M18: IssueContract を「埋め込み」から「参照」へ**。`Issue.contract`
  （[schema.ts](../../src/domain/schema.ts) L108）を廃し `specRef`+`acceptanceCriteriaIds`+設計スライス参照に置換（D8・D13）。
- **新設モジュール**: M20 オーサリング層 / M21 Design Planner。
- **M11 Release**: auto-merge をやめ、承認ポリシー注入点に置換（D12）。

## 5. 状態機械（M03 で確定）— 二段ライフサイクル

```text
epic（spec.md）ライフサイクル（オーサリング + 設計。issue 化前）:
  planned → ready-for-contract → contract-drafting(協業) → contract-approved(署名)
          → designing(M21) → decomposed(issue 群を spawn)

issue（work order）ライフサイクル（投稿時に生成）:
  ready-for-generation → generation-in-progress → ready-for-evaluation →
  evaluation-in-progress(auto 全 pass) →
  [human_review ゲート: MR/release があれば needs-human-review へ] →
  build-approved → ready-to-release →（人間リリースゲート）→ released
  needs-human-review: 層別差し戻し（authoring / M21 / repair）or approve で復帰
```

命名衝突の解消（M03 確定時に最終化）:

- 旧 `approved`（eval 合格）→ `build-approved`（人間署名の `contract-approved` と区別）。
- 旧 `ready-to-merge` → `ready-to-release`（人間リリースゲートを明示）。

## 6. 自動化境界（D18）

| 人間にしかできない（残す） | 全自動（人間が触らない） |
| --- | --- |
| spec.md / AC のオーサリング + **署名（contract-approved）** | 詳細設計（M21: Tier1/Tier2） |
| **リリース承認ゲート**（本番 merge, §2.2） | resolve（spec→IssueContract） |
| human_review タグ時の検証（MR 監査 / 該当スライス） | 実装（Generator）・**PR 作成** |
| **drift 時の再署名** | 評価（Evaluator）+ scorecard・修正ループ |
| （任意）issue スライス・Tier1 スパインの override / レビュー | issue 自動スライス・status 遷移・進捗集約 |

注: 人間が読むのは **human_review タグが指す箇所のみ**（全体読みの義務は生じない, D16・D17）。

## 7. 成果物（このセッション）

- [templates/feature-spec.md](../../templates/feature-spec.md) — spec.md テンプレート
  （O1 反転済み: meta=frontmatter / behavior+subArea のみ / verification 分離。2026-06-15）。
- [templates/acceptance.yaml](../../templates/acceptance.yaml) — verification（AC-ID キー・O1 反転で新設）。
- [templates/manual-requirements.md](../../templates/manual-requirements.md) — 要審査要件票。
- [docs/spec/modules/authoring-layer.md](../modules/authoring-layer.md) — M20（**確定** 2026-06-15）。
- [docs/spec/modules/design-planner.md](../modules/design-planner.md) — M21（下書き 2026-06-15）。

## 8. 未決事項 / 決定ログ

O1-O4 解決済（簡易アプリ通しで確認）:

- **O1 → 反転で解決（D15）**: embedded YAML をやめ spec.md(behavior) + acceptance.yaml(verification)。
- **O2 → 確定（M20 v2 訂正 2026-06-15）**: 署名記録の最初の永続先は **epic 状態オブジェクト**。issue は
  decomposed 後に生成されるため「issue が承認記録」は転記後の話（issue を最初の置き場にできない）。
  詳細: [modules/authoring-layer.md](../modules/authoring-layer.md) §3.4。
- **O3 → 確定（M20 v2 訂正 2026-06-15）**: drift は **二段**（path 単位で変更有無 → AC 単位の構造 diff で
  変更 AC-ID を特定）。「path 単位 diff のみ」では AC-ID を特定できない。ApprovedSpecRef に AC 単位
  ハッシュ（`acFingerprints`）を持つ。詳細: authoring-layer.md §4 / AUTH-FR-008。
- **O4 → 確定**: drift 再署名は **変更 AC-ID のサブセットのみ**（`approvedAcIds` から外して表現）。

残 open:

- ~~M21 の Tier1/Tier2 出力スキーマと、resolve(M05) への引き渡し形式の確定。~~
  → [modules/design-planner.md](../modules/design-planner.md)（M21 下書き）で確定。
  Tier1=`ArchitectureSpine` / Tier2=`DesignSlice` / handoff=`IssueSpawnOrder`（参照のみ・D8）。
- Hermes 進捗集約 join の報告面（Dashboard / レポート）。
- 実装シーケンス（埋め込み契約の参照化・状態機械二段化・auto-merge 廃止・テンプレート更新の順序）。
- M20/M21 のモジュール化（README 地図への M21 追加・M20 確定）。
