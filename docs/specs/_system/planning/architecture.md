# アーキテクチャ — planning コンテキスト

> 計画の木の public な形（他ユニットが噛み合う署名/契約）のみ——内部実装は書かない。ドメイン id は
> [domain-model.md](domain-model.md)（`DOM-planning-NNN`）から参照する。追加のみ（`ARCH-planning-NNN` は安定）。

## モジュール境界と seam

- **ARCH-planning-001 roadmap-planner** — 責務: 製品ゴールを outcome・順序付きの epic ＋ feature へ分解する**判断**（`DOM-planning-001..003`）。決定論コアの外部にあり、その*質*は契約化しない。public な形: 受け入れ基準を持たない roadmap 値を出す（`PlannedRoadmap`: epic → feature が `title` ＋ `outcome` を持つ・**AC なし**）。
- **ARCH-planning-002 planRoadmap（取込）** — 責務: planner の roadmap を計画の木へ決定論的に永続し、ゲートを強制する（`DOM-planning-006`/`008`）。public な形: `planRoadmap(store, rawRoadmap): PlanResult`——追加数・descope 数を返し、ゲート違反時は（場所を示す）`PlanIngestError` を投げ、何も永続しない。
- **ARCH-planning-003 spawnSpecs（実体化）** — 責務: 各 in-plan feature を、ちょうど 1 つの spec dir ＋追跡される未署名 SpecState へ materialize する（`DOM-planning-007`）。public な形: `spawnSpecs(store, opts?): { spawned, dirs }`——冪等; ファイルは不在のときだけ書く。
- **ARCH-planning-004 store（永続 seam）** — 責務: 木が住む耐久 Eval Result DB（`DOM-planning-001..005`）。public な形: `addEpic` / `addFeature`（双方向リンクを配線）・`upsertSpecState`・`getSpecState`・`nextId(prefix)`（連番 `EPIC-NN`/`FEAT-NNN`/`ISSUE-NNNN`）。
- **ARCH-planning-005 sign（authoring seam）** — 責務: 人間の承認を版固定 `ApprovedSpecRef` として記録する（`DOM-planning-005`）。public な形: `sign <spec-dir>`——authoring lint ゲートを通し、spec の commit クリーンを要求し、HEAD blob SHA を pin する。**承認は人間の判断点; 本コンテキストの何物も自律的に署名しない。**
- **ARCH-planning-006 traceFeature** — 責務: 1 つの feature について鎖を双方向に解決する（`DOM-planning-012`）。public な形: `traceFeature(store, featureId): FeatureTrace | null`——`linked` が `AC-PLAN-008` の到達可能性判定。

## 共有基盤

- **ARCH-planning-007 core/clock** — public な形のみ:
  - `now(): string` <!-- 注入される ISO-8601 クロック; 取込/spawn の全タイムスタンプがここを通るので run が再現可能 -->

## 横断ポリシー

- **決定論の境界**: 決定論コア（取込/spawn/トレース）は機械的不変条件のみを持つ; あらゆる*判断*（どの feature か・どの順か）は `roadmap-planner`（`ARCH-planning-001`）に留め、コアに埋め込まない。
- **fail-closed ゲート**: 取込ゲート違反は書込み前に投げる——計画の木は取込単位で all-or-nothing（`DOM-planning-006`/`008`）。
- **seam での id と時刻**: id は store だけが採番する（`nextId`）; 時刻は `now()` だけを通す——モジュールは自前で生成しない。

## アーキテクチャ不変条件

- **ARCH-planning-008** — あらゆる永続変更は store seam（`ARCH-planning-004`）を通る; どのモジュールも DB の形を直接書かないので、双方向リンクが整合し続ける。
- **ARCH-planning-009** — `planRoadmap` と `spawnSpecs` は（store 状態・入力・`now`）の純関数: 同一入力 ⇒ 同一の木（NFR 決定論）; 隠れたクロックや乱数を持たない。
