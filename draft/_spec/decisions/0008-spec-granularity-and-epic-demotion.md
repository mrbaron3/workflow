# 決定記録 0008: spec は粒度非依存の著述・署名単位（epic はロードマップ・グルーピングへ降格）

- 状態: 確定
- 最終更新: 2026-06-26
- 影響モジュール: M20 オーサリング層 / M21 Design Planner / M22 Design Reviewer / M05 Issue Contract
  Planner / M18 Storage / M03 Coordinator / `to-spec`・`to-basic-design`・`to-db-design`・
  `to-detail-design` skill
- 正本差分: ADR-0001（O1/D4「Epic = 1 spec.md」）と ADR-0004 D30（設計「epic 層」の命名）を**更新**（§5）。
  GLOSSARY の Epic/Spec を改訂。REQUIREMENTS.md への上書きなし。

## 1. 背景

[ADR-0001](0001-authoring-execution-split.md) が WHAT（オーサリング）と HOW（設計・実装）を分離し、
「**Epic = 1 spec.md = 1 機能**」を著述・署名の単位とした。しかし `to-spec` のドッグフード（最上流
M20 認可層への適用）で、この前提が**重すぎる**ことが露呈した。

- 人間の責務は「作りたいもの/機能を AI と会話して受け入れ要件（spec）に落とす」ことだけで、**作りたい
  ものの粒度に依存しない**。「Todo アプリを作りたい」も「タスクに有効期限を追加したい」も等しく spec の入力。
- 「Epic = 1 spec.md」は、この2つを**両方とも epic** にしてしまう。アプリ丸ごとと1フィールド追加が同じ
  "epic" になるのは語義破綻で、GLOSSARY 冒頭が戒める「Sprint を1機能に多重定義するな」と同根の多重定義。
- 実態として、著述・lint（M20 / check-spec）も resolve（M05）も drift も**既に AC 単位**で、epic 粒度に
  依存していない（[resolve.ts](../../../src/resolve/resolve.ts) は `epicId` を読まない）。コード上の `Epic`
  は既に「issue を束ねる進捗グルーピング」（`Issue.epicId` は nullable）で、契約を持たない。

つまり重さは強制コードでなく **"epic = 著述単位" という概念前提**に乗っていた。これを外す。

## 2. 確定した決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D50 | **spec は粒度非依存の著述・署名単位**。人間 + AI が WHAT を spec（`spec.md` + `acceptance.yaml`）へ落とし、`contract-approved` は **spec** に対して成立する。住処は `<spec-dir>`（旧 `<epic-dir>`）。`to-spec` は粒度を所与とせず carving もしない | 人間の責務は粒度に依存しない。著述も整合強制も既に AC 単位で epic に依存しない |
| D51 | **epic は下流のロードマップ/進捗グルーピング**（issue の束・`Issue.epicId`・`Epic.issueIds` の進捗ロールアップ）。**著述単位でも設計 tier でもない。1 spec ≠ 1 epic** | コードの `Epic` は元から契約を持たない grouping。GLOSSARY L27「Epic = a big capability decomposed into many issues」と整合。多重定義を解く |
| D52 | **実現の道筋への分解（slices = issues）は下流の責務**（設計層 = `to-detail-design` / resolve = M05）。配線は AC 単位で部分集合を既に許すため**新機構は不要**。identity のみ改名: `ApprovedSpecRef` は spec を指す（`epicId`→`specId`）、`Issue.specRef = { spec ref(path+gitSha), coversAcIds(部分集合) }` | resolve は AC-ID 部分集合 + AC 単位 drift で動く（epic 不使用）。分解は HOW で下流 |
| D53 | **柔らかい凝集上限**: spec は「人間が一度に署名できる凝集した capability」1つ。ロードマップ規模（アプリ丸ごと）はチャットで「ロードマップ → 複数 spec」と指摘し**上流**（north-star / ロードマップ）で割る。`to-spec` は機械的には粒度非依存のまま（大 spec を拒否も強制もしない） | 無制限の spec は署名不能。だが粒度はゲートでなく指針。強制は altitude 違反 |
| D54 | **ADR-0004 の設計 tier「epic 層（1 spec.md = 1 epic）」を「spec 層」へ改名**。`to-detail-design` / `to-basic-design` / `to-db-design` は **per-spec**（`epic_dir`→`spec_dir`）。三層は system / **spec** / slice | "epic" を設計 tier から降ろし grouping へ戻す。spec 層の被覆不変条件「slices == spec の AC 全集合」は不変 |

## 3. spec と epic の関係（改）

```text
roadmap / initiative（例: 「Todo アプリ」）         ← 上流（north-star / ロードマップ）が複数 spec へ割る
  └─ spec（粒度非依存の WHAT・署名単位・contract-approved）    ← to-spec（M20）。1 spec = 1 凝集 capability
       └─ system / spec / slice の三層設計（ADR-0004・D54 改名）   ← 設計層が spec から slices を切る（下流）
            └─ slice = issue（PR サイズ・coversAcIds 部分集合）     ← resolve（M05）が AC 部分集合を契約へ射影
                 └─ epic = issue の束（ロードマップ/進捗グルーピング）  ← 下流で付与。1 spec ≠ 1 epic
```

「Todo アプリを作りたい」= roadmap → 複数 spec。「有効期限を追加」= 1 spec → 数 slices/issues。どちらも
"epic そのもの" ではなく、epic は下流分解の後に初めて関係する。

## 4. このコミットで実施 / follow-up（blast radius を残さず記録）

このコミットで実施（自己完結コア）:

- 本 ADR（決定記録）。
- GLOSSARY: **Spec** 追加・**Epic** 再定義（§5）。
- `to-spec` skill: carving 撤去 → 凝集指針、`<epic-dir>`→`<spec-dir>`、`references/edge-cases.md` 改訂。
- ADR-0004 に本 ADR へのポインタ banner。

追って実施済み（FU-1/2/3・同一作業で完了）:

- **FU-1** 設計 skill 3種（`to-detail-design`/`to-basic-design`/`to-db-design`）: `epic_dir`→`spec_dir`・
  「one epic per run」→「one spec per run」・description・`SLICE-<EPIC>-NNN`→`SLICE-<SPEC>-NNN`・check
  スクリプト・`src/design/lint.ts` コメント（→ `bundle-skills` 再 vendor）。
- **FU-2** 「epic 状態オブジェクト」→「spec 状態オブジェクト」: authoring-layer.md / design-planner.md /
  design-reviewer.md / issue-contract-planner.md / `specs/authoring-layer/`（昇格 spec + acceptance.yaml）/
  `to-spec` テンプレ。`ApprovedSpecRef.epicId`→`specId`。README §95・ADR-0001/0002/0007 banner。
- **FU-3** src 整理: 未使用の `ResolvedSource.epicId`（+ test fixture）を削除。
- ドッグフード findings（[2026-06-25](../../../docs/brainstorm/2026-06-25-dogfood-m20-to-spec-findings.md)）の
  DF1 解決（「`to-spec` に carving を教える」）は本 ADR D50-D53 が**置換**する。

残 follow-up（別タスク・承認制）:

- [`draft/_spec/loop1-walkthrough.md`](../loop1-walkthrough.md) は旧「epic = spec.md」フレームで全面記述
  （`epicId=EPIC-TODODUE`・epic ライフサイクル・`DesignDelta(EPIC-…)` 等）。token 置換でなく概念的な
  書き直しが要る。

## 5. ADR-0001 / 0002 / 0004 / 0007 / GLOSSARY の更新

- **ADR-0001**（O1/D4「Epic = 1 spec.md = 1 機能」）を「**spec = 粒度非依存の著述・署名単位。epic は下流の
  grouping**」へ更新（本 ADR が supersede）。「`contract-approved` は epic でなく **spec** に成立」。
- **ADR-0004 D30**: 設計三層の「epic 層」→「**spec 層**」（D54）。tier の中身（design-delta + slices・
  被覆不変条件）は不変。
- **ADR-0007 D46/D49**: 設計粒度の「epic 単位」「slice = epic / PR」を **spec** 単位へ（D54 と一体）。
- **ADR-0002 D23**: 「epic 状態機械（`designing → design-reviewed → decomposed`）」を **spec 状態機械**へ
  （状態遷移は不変）。
- **GLOSSARY**: 「Epic = 1 spec.md」を外し、**Spec**（署名単位・任意粒度）を新設、**Epic**（下流の issue
  grouping）を再定義。

## 6. 残 open

- 設計 skill / 状態機械語彙の改名（§4 follow-up）の実施順と、`SLICE-<EPIC>-NNN` ID 体系を
  `SLICE-<SPEC>-NNN` にするか（ID 安定性 vs 命名整合）。実施タスク着手時。
- 「凝集した capability」の運用的な見極め（どこからロードマップか）は焼かず、北極星/ロードマップ役の
  運用から起こす（D53）。
