# ドメインモデル — planning コンテキスト

> 計画の木の戦術的 DDD。語彙は [ubiquitous-language.md](ubiquitous-language.md)（`LANG-planning-NNN`）から
> **参照**し、再定義しない。単一正本・追加のみ（`DOM-planning-NNN` は安定・renumber 禁止）。

## エンティティ／集約

- **DOM-planning-001 Roadmap** — 同一性: store につき単一; 所有: vision・principles・順序付き `epicIds`; 計画の木の集約ルート（`LANG-planning-001`）。集約ルート: yes。
- **DOM-planning-002 Epic** — 同一性: `EPIC-NN`; 所有: 題目・テーマ・順序付き `featureIds`; roadmap に属す（`LANG-planning-002`）。集約ルート: no（Roadmap 集約の一部）。
- **DOM-planning-003 Feature** — 同一性: `FEAT-NNN`; 所有: 題目・outcome・status・`inPlan` フラグ; ちょうど 1 つの Epic と高々 1 つの Spec を参照する。計画の木の**葉**であり system の木との**交点**（`LANG-planning-003`）。集約ルート: yes（ライフサイクルは再取込から独立）。
- **DOM-planning-004 SpecState** — 同一性: spec dir のパス; 所有: spec の署名ライフサイクル（`featureId`・`approved`・`signedAt`）。署名の最初の永続先（`LANG-planning-006`/`011`）。集約ルート: yes。
- **DOM-planning-005 ApprovedSpecRef** — SpecState が所有する**値オブジェクト**：1 回の人間の承認の不変な版固定（`LANG-planning-011`）。固有の同一性は持たず、再署名で丸ごと置換される。

## 関係と境界

- Roadmap は Epic 群を**含む**（順序付き `epicIds`）; Epic は Feature 群を**含む**（順序付き `featureIds`）; どちらのリンクも双方向（`Feature.epicId` ↔ `Epic.featureIds`）。
- Feature はちょうど 1 つの SpecState へ**実体化**する（`Feature.specPath` ↔ `SpecState.featureId`）——1:1・排他の対応。
- SpecState は 0 個または 1 個の ApprovedSpecRef を**保持**する（初回署名まで `null`）。
- **execution コンテキストとの境界**: planning コンテキストは*署名された spec* で終わる。署名 spec を Issue へ分解し、その下流（PR・EvalRun）を扱うのは execution コンテキストの関心事。Issue は `specPath`/`featureId` で逆参照されるが、その**スキーマは本コンテキストでは設計しない**（lazy boundary）。
- **authoring コンテキストとの境界**: AC 著述＋ドリフト検知（to-spec・`fingerprint`/`deriveStatus`）は authoring コンテキスト。planning は署名された署名（signature）を証拠として*消費*するだけで、AC を著述しない。

## ドメイン不変条件・イベント・状態

- **DOM-planning-006** — Feature（および roadmap/epic ノード）は**受け入れ基準を決して持たない**; AC は署名された Spec の中にのみ存在する。取込は AC 入り入力を拒否する（`AC-PLAN-001`/`AC-PLAN-006`）。
- **DOM-planning-007** — **1 Feature = ちょうど 1 Spec**・排他: どの spec も 2 つの feature に共有されず、同題目の 2 feature も別個の spec dir を得る（`AC-PLAN-003`/`AC-PLAN-004`）。
- **DOM-planning-008** — Feature は非空の `outcome` を要する; outcome 不在の feature／outcome の無い epic は取込時に拒否され、木は不変のまま（`AC-PLAN-002`）。
- **DOM-planning-009** — 再取込は **additive かつ冪等**: 同一 roadmap の再取込は構造的 no-op; 署名済みの SpecState（とその ApprovedSpecRef）は決して変更・上書きしない（`AC-PLAN-005`/`AC-PLAN-007`）。
- **DOM-planning-010** — descope は**削除でなくフラグ**: roadmap 源から feature を外すと `inPlan=false` に反転し、その署名済み spec dir ＋署名を保全する（`AC-PLAN-009`）。
- **DOM-planning-011** — Feature の status は前進ライフサイクル: `planned → specced → signed → implemented`。spawn は `planned → specced`、spec の署名は `signed` へ進める。
- **DOM-planning-012** — トレース（`LANG-planning-014`）は署名済み feature について双方向に解決する: north-star/roadmap → epic → feature → spec → 承認された AC、および全逆リンク（`AC-PLAN-008`）。
