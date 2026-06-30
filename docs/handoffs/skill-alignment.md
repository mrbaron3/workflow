# ハンドオフ：下流スキルを理想形へ整合

> 別セッションで cold-start するための作業引き継ぎ（**transient**・作業完了後は削除可）。
> 作成: 2026-06-28

## 更新 (2026-06-30)

**A（スキル修正）と B（planning-tree 実装）は完了。spec→issue の配線も埋まった。残りは C（実データで通す）。**

- 完了済み（コミット済み）: schema デルタ（ee52e34）／ to-detail-design Issue 化〔A.1〕（ea44892）／
  to-system-design 4ビュー分離〔A.2〕（89e1360・3cca1e9）／ to-spec supersedes・dependsOn〔A.3〕（3cc518f）／
  planning-tree `planRoadmap`＋`spawnSpecs`〔B〕（eb228f3）。
- 完了済み（**未コミット**・本セッション）: **`spawnIssues`（issues.yaml → store `ISSUE-NNNN`）＋ CLI `spawn-issues`
  ＋テスト**。`spawnSpecs` の鏡。`issueSpawnVerdict` ゲート = 未署名 hard error／lint 失敗 hard error／spawn 済み skip。
  これで §次セッションの未決事項「ブートストラップ順（鶏卵）」は**解消**（to-detail-design の Issue 化が先に実装済み）。
- **次にやること = item C を実走**（下記 §item C を実走）。コードの欠落ではなく「**署名待ち**」が起点。

### item C を実走（次セッションの主タスク）

planning-tree spec（`docs/specs/planning-tree/`・9 AC・lint pass・**人間の署名待ち**）を、修正後のスキル群で
end-to-end に初走させる。これが「自律 × 評価 × 改善」の鎖を実データで一本通す最初の機会。

1. **人間が署名**: `agentops sign docs/specs/planning-tree`（spec.md / acceptance.yaml を commit 済みにしてから。
   署名は HEAD blob を pin する）。
2. **system 層を実体化**〔A.2 を使う／item C〕: to-system-design で `docs/specs/_system/<ctx>/` に 4ビュー
   （`ubiquitous-language.md`・`domain-model.md`・`architecture.md`・`data-model.md`＝DBML SSOT）を著述。
   前方参照 AC-PLAN-008（data-model seed）を解消。
3. **issue 化**〔A.1 を使う／item C〕: to-detail-design で `docs/specs/planning-tree/issues.yaml` を著述し、
   `npx tsx <skill>/scripts/check-detail-design.ts docs/specs/planning-tree` で被覆×排他を pass させる。
4. **取込**: `agentops spawn-issues docs/specs/planning-tree` → store に `ISSUE-NNNN` が落ちる（lint 権威再実行・冪等）。
5. **run ループ**: `agentops run` で Generate → Evaluate → Repair → Release（既定は mock backend）。
6. 詰まり所の想定: 署名は git クリーン前提（未コミットだと拒否）／ to-system-design は本 spec で未実行（初回）／
   `_system` 配置は `<spec-dir>/../_system` 既定（`spawn-issues` の `--system` ではなく `spawnIssues` opts で上書き可）。

## 目的（なぜ）

理想の文書形（[DOC_TAXONOMY](../_meta/DOC_TAXONOMY.md)）とライフサイクル（[DOC_LIFECYCLE](../_meta/DOC_LIFECYCLE.md)）を
確定し、`docs/specs/planning-tree/` の spec を著述・lint 通過させた（**署名待ち**）。一方、下流スキル
（to-system-design / to-detail-design）と to-spec のテンプレは、これらの理想形より前に作られており**出力が
整合していない**。下流を走らせる前にスキル側を整合させる。

**重要な前提**: このハーネスは整合性を**コードで強制**する（各スキルの `scripts/check-*.ts` が `src/` の lint を
**vendor**）。よって整合は「SKILL.md だけ」ではなく **SKILL.md ＋ vendored lint/check ＋ `src/` schema/lint を
lockstep** で動かす。スキル文だけ直しても check が旧不変条件のままなら破綻する。

## 最初に読むもの（canonical）

- [docs/NORTH_STAR.md](../NORTH_STAR.md) — 自律 × 評価 × 改善。状態は監査可能・証拠が蓄積される。
- [docs/_meta/DOC_TAXONOMY.md](../_meta/DOC_TAXONOMY.md) — 関心 × 高度 × ズーム。7ビュー・ID 体系・2本の木・理想ツリー。
- [docs/_meta/DOC_LIFECYCLE.md](../_meta/DOC_LIFECYCLE.md) — 時間モード。著述 SSOT は2つ・派生ビュー（案A）・slice→issue。
- [docs/GLOSSARY.md](../GLOSSARY.md) — 用語（spec ≠ epic、Issue Contract 等）。
- **`Development/workflow/CLAUDE.md` §Agent Skill 著述規約（必守）**: 正本 `SKILL.md` ＋ **必須 `SKILL.md.ja`
  併設・同期**、`description` は日本語、相対パスで skill 外へ登らない、`scripts/` から `scripts/lib/` の
  vendored lib、skill は薄く（rubric を焼かず scripts/ へ委譲）、テンプレは root `templates/` 単一住処
  （単一 skill 専用は `assets/`）、共有 deterministic lib は `src/` 単一ソース→skill へ vendor。
  着手時に **Anthropic 最新公式ベストプラクティス**を確認し本規約と整合させる。

## この会話で確定した設計判断（前提）

- **案A（派生ビュー）**: 「アプリの現在仕様」は著述せず、署名 spec を畳んだ projection（`_derived/`）。
- **slice→issue 一本化**: slice は markdown 文書でなく **store の Issue**。to-detail-design は Issue を生成する。
- **2本の木**: 計画の木（North Star→Roadmap→Epic→Feature）と system の木（7ビュー）が **spec で交わる**。
- **計画の木の配線**: roadmap-planner（判断）→ `planRoadmap`（決定論・取込）→ `spawnSpecs`（決定論・spec 化）。
  詳細は会話ログ／`docs/specs/planning-tree/spec.md`。
- **レガシー温存**: `src/planning/planner.ts` の `planFromSeed`＋`seed/sample-roadmap.yaml`（AC インライン）は
  pre-M20。`planFromSeedLegacy` として残し、オフライン `agentops demo` を壊さない。新配線を主経路にする。

## A/B/C：作業の区別（planning-tree はスキル修正ではない）

本ハンドオフ §スキル別 が扱うのは **A のみ**。planning-tree は別物（**B/C**）で、A の上に乗る。

| | 作業 | 中身 | 種別 |
|---|---|---|---|
| **A** | 既存スキル修正 | to-detail-design / to-system-design / to-spec ＋ vendored check/lint ＋ 共有 schema デルタ | スキル修正（**ここから始める**・本書 §スキル別＝これ） |
| **B** | planning-tree 実装 | `Feature` / `planRoadmap` / `spawnSpecs` の**新規 src/ コード** ＋ `agents/roadmap-planner.md` の出力契約更新（SeedRoadmap → AC 不可の v2） | **新規機能**（スキル修正ではない） |
| **C** | planning-tree を通す | 署名 spec を**修正後のスキルで消費**：to-system-design が data-model seed（AC-PLAN-008）→ to-detail-design が issue 化 → B を実装 | スキルの**利用** |

**関係（bootstrap）**:

- 共有の最初の一歩 = **schema デルタ**（`Feature`・`Issue.featureId/specPath/coversAcIds`）。A の to-detail-design も
  B の実装も依存する → §推奨シーケンス 1 を最初に置く理由。
- 鶏卵: planning-tree の署名 spec を issue に分解するには、先に to-detail-design を issue 化しておく必要がある。
  よって **schema → to-detail-design（＋他スキル）修正〔A〕→ planning-tree 実装〔B/C〕** の順。
- 注意: planning-tree を「スキル修正」と捉えると B の**新規 src/ 実装**を見落とす。A と B/C は別工程。

## スキル別 ギャップと目標

### 1. to-detail-design（最大の変更：slice 文書 → Issue）

- 現状: `slices/SLICE-<SPEC>-NNN.md` ＋ `IssueSpawnOrder` を**著述**。
- 目標: 署名 spec から **Issue Contract を store に生成**。`coversAcIds` / `dependsOnSystem` / seam の
  `implementationNotes` は **issue のフィールド**。被覆×排他は「**この spec から spawn された issue 集合**」で検査。
  markdown の slice は廃止。
- 連動コード: `domain/schema.ts` の `Issue` に `featureId` / `specPath` / `coversAcIds` を追加。
  `scripts/check-detail-design.ts` ＋ vendored `src/design/lint.ts` を「issue 集合の被覆」検査へ。

### 2. to-system-design（ビュー分離・欠落追加）

- 現状: `domain-map.md`（言語をドメインに内包）／`architecture.md`／`data-model.md`。
- 目標（DOC_TAXONOMY 7ビュー）:
  - **言語を分離** `ubiquitous-language.md`（`LANG-<CTX>-NNN`）。
  - `domain-map.md` → `domain-model.md`（`DOM-<CTX>-NNN`）。
  - `data-model.md` に **DBML を構造化 SSOT、Mermaid `erDiagram` を派生**（DOC_TAXONOMY §データビューの実体化）。
  - **契約 `contracts/`**（`CONTRACT-<CTX>-NNN`・OpenAPI/AsyncAPI）を first-class 化。
  - **`context-map.md` 索引**（境界 + DDD 関係パターン）。
- 連動コード: `scripts/check-system-design.ts` ＋ vendored `src/design/lint.ts` に新ファイル・新 ID 空間を認識させる。
- 判断必要: **cross-cutting NFR / ADR は system 横断**（境界単位でない）。to-system-design が持つか別スキルか。

### 3. to-spec（軽微・直近で使用済み）

- `supersedes` フィールドをテンプレ（`assets/feature-spec.md`）＋ lint（`src/authoring/lint.ts`）に追加
  （DOC_LIFECYCLE の fold 鍵・現状未実装）。
- 構造化 `dependsOn`（`LANG/DOM/DATA/CONTRACT/NFR` の ID 参照）をテンプレに。
- 参照する system 層の**ファイル名を更新**（`domain-map.md` → `domain-model.md` ＋ `ubiquitous-language.md`）。

### 4. 純新規（後回し・別作業）

context-map / contracts 著述 / cross-cutting NFR / ADR ログ / 派生ビュー（feature-catalog・traceability）/
`supersedes` 機構（`src/`）。これらは「更新」でなく新設。DOC_LIFECYCLE・DOC_TAXONOMY で前方参照済み。

## 連動コード（整合はコードが強制）

- `src/domain/schema.ts`: `Feature` 追加、`Epic.featureIds`、`Issue.featureId/specPath/coversAcIds`、
  `SpecState.featureId`、`DB.features`。
- `src/design/lint.ts` / `src/authoring/lint.ts`（単一ソース）を更新したら、各スキルの **vendored copy を
  再 vendor**（`scripts/lib/`）。スキル script は実行時に `src/` を読まない＝コピーがずれると破綻する。

## 推奨シーケンス

> 状態は §更新 (2026-06-30) 参照。1〜4 は完了（4 のスキル整合まで）。残りは 5（純新規）と、別軸の **item C 実走**。

1. ✅ **schema デルタ**（Feature / Issue リンク）— 以降を unblock。（ee52e34）
2. ✅ **to-detail-design → Issue 化**（＋ check ＋ **`spawnIssues` 取込**）— planning-tree の臨界経路。（ea44892 ＋ 本セッション）
3. ✅ **to-system-design ビュー分離 ＋ data-model DBML**（スキル整合）— 実データへの実体化は item C 手順2。（89e1360・3cca1e9）
4. ✅ **to-spec 仕上げ**（supersedes / dependsOn / ファイル名）。（3cc518f）
5. 純新規スキル・派生ビュー・supersedes 機構（`src/` の fold）— 後続（本書 §スキル別 4）。

## 次セッションの未決事項

- ~~**ブートストラップ順**（鶏卵）~~ — **解消**（2026-06-30）。to-detail-design を先に Issue 化し、`spawnIssues` を実装。
  これで署名済み planning-tree spec を `spawn-issues` で取込できる（§item C を実走）。
- NFR / ADR / context-map は to-system-design 所属か別スキルか。
- vendored lib の同期手順（既存 convention の確認・自動化の要否）。
- 派生ビュー（feature-catalog / traceability）の生成器の住処。

## 完了の定義（各スキル）

- `SKILL.md` ＋ `SKILL.md.ja` 同期済み。`scripts/check-*.ts` が sample で pass。
- 出力が DOC_TAXONOMY のツリー・ID 体系に一致。`npm test` ＋ `npm run typecheck` green。

## 引き継ぎ時点の状態

- `docs/specs/planning-tree/spec.md` ＋ `acceptance.yaml`：著述済み・lint pass（9 AC）・**人間の署名待ち**。
- 文書配置: メタ（DOC_TAXONOMY / DOC_LIFECYCLE）は `docs/_meta/` へ隔離済み（疎結合分・完了）。
  `ARCHITECTURE.md` / `GLOSSARY.md` → `_system/` 移設は **未**（to-system-design 整合と同時・上記 §2）。
- 下流スキル整合は完了。**下流は実データで未実行**（item C が初走）。
- 署名後の本来の経路: 署名 → to-system-design で data-model seed（前方参照 AC-PLAN-008 解消）→
  to-detail-design で issues.yaml → **`spawn-issues` で取込（`ISSUE-NNNN`）** → `agentops run`。
  （配線は `planRoadmap` / `spawnSpecs` / **`spawnIssues`** で全段実装済み。残るは実走＝§item C を実走。）
