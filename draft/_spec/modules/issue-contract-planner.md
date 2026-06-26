# M05 Issue Contract Planner（resolve）仕様

- 正本参照: ADR-0001（[decisions/0001](../decisions/0001-authoring-execution-split.md) D8/D10/D13）,
  ADR-0003（[decisions/0003](../decisions/0003-spec-altitude-and-dry.md) D26/D28/D29）,
  ADR-0004（[decisions/0004](../decisions/0004-layered-design-and-global-review.md) D31・spine→system 層）,
  REQUIREMENTS.md §11（Issue Contract 関連 FR・resolve 側へ再配分）, §12（Generator 入力の前提）
- 参考実装: [agents/issue-planner.md](../../../agents/issue-planner.md)（**分割元**: 設計判断は M21 へ、
  resolve 機械処理を本 M05 へ）, [src/planning/planner.ts](../../../src/planning/planner.ts)（**置換**方針）,
  [src/domain/schema.ts](../../../src/domain/schema.ts)（`IssueContract` zod schema = 現行実装。M01 抽出時に本仕様へ追従）
- 仕様状態: 下書き
- 最終更新: 2026-06-18

## 1. 目的とスコープ境界

**版固定された承認済み著述物**を入力に、1 issue 分の **`IssueContract` を機械的に投影（resolve）** する層。
M03 Coordinator が issue を dispatch する時点で呼ばれ、Generator / Evaluator が消費する契約本体を生成する
（ADR-0001 §3 ⑥）。

本層は **全 lane 共通の「組み立て + validation コア」**である。issue の発生源（lane）は複数ある:

- **greenfield 分解**: 承認済み epic spec.md を M21 が Tier1/Tier2 設計して PR サイズに分解した 1 スライス。
- **issue 粒度の票**: bug / tech-debt / harness / eval / 既存プロジェクト導入（brownfield）など、epic を経由せず
  最初から 1 issue 粒度で著述された票（[schema.ts:35-43](../../../src/domain/schema.ts#L35-L43) の `IssueType` が
  これらを既定する: `bug` / `tech-debt` / `harness` / `eval`）。

これらを **uniform な `IssueSource`（§2）** に正規化し、source の種別に依らず**同一の resolve 処理**で
`IssueContract` を生成する。設計（判断）と契約 resolve（機械処理）は性質が違うため分離する（D13）。本層は
**resolve の実体のみ**を担い、出力フィールドはすべて版固定の `IssueSource` から **join / copy** で導出できる——
もし resolve が何かを「決める」必要に迫られたら、それは上流（M21 設計 / M20・targeted 著述）に欠落がある
合図であり、本層では創作しない（決定性を守る）。

担う:

- `IssueSource` を入力に、behavior + severity（spec / 票）・verification（acceptance.yaml）・narrative・scope・
  redLines を **join / copy** して `IssueContract` を組み立てる（greenfield / targeted を区別しない）
- 出力の **schema validation**（zod `IssueContract`）。invalid は **緩めず reject**（planner.ts L69 の精神を継承）
- dispatch 時の **drift gate**: 承認時の `acFingerprints` と現版の AC 単位ハッシュを照合し、版ズレが
  あれば resolve せず層別差し戻し（WHAT→著述層 再署名）
- **被覆 cross-check**: 出力 AC-ID 集合 == `IssueSource.acceptanceCriteriaIds`（slice がある時はさらに
  `tier2SliceRef.coversAcIds` も一致 = 三者一致）
- **再 split 後の再 resolve（B5 受け側）**: PR サイズ超過は実装後に Generator が検知し M21 へ feedback、M21 が
  再 split する。本層は**サイズを判定せず**、新スライスを決定的に再 resolve するだけ（§5 foundation drift と同経路）

担わない（隣接モジュール）:

- 詳細設計（Tier1/Tier2 著述）・AC のスライス割付・分解判断 → M21 Design Planner
- **PR サイズの見積り・閾値判定**（B5 の*検知*）→ M21（設計時見積り）/ Generator（実装後の実サイズ）。本層は
  resolve 時に「実サイズ」を知る決定的メトリクスを持たず、サイズを判定しない（判定は決定性に反する）
- spec.md / acceptance.yaml / issue 票の**作成・署名・drift 再署名の意思決定** → M20 オーサリング層
  および targeted lane の起票（triage / M02 Hermes / M10 / M12）。本層は drift を**検知して差し戻す**のみ
  （再署名は人間: O4）
- 自然言語の意図分類・抽象度判定・issue 票の起票そのもの（bug/tech-debt/brownfield の intake） → M02 Hermes /
  triage / M10 Eval Curator / M12 Harness Analyst（本層はその出力 `IssueSource` を consume）
- issue の投稿・状態ラベル書き込み・ポーリング・dispatch・ロック・worktree → M03 Coordinator
- 実装 → M06 Generator / 評価 → M07 Evaluator / 設計審査 → M22 Design Reviewer

> スコープ境界の要点（D13）: 上流の各 lane は **判断**（どう分割し・どう設計し・何を直すか）と**著述**
> （behavior + verification + narrative）を出力し、本層はそれを `IssueSource` として入力に **機械的に**
> `IssueContract` を組み立てる。本層は新しい設計情報も新しい受け入れ要件も生まない。源泉に無い値を埋めたく
> なったら、その不足は上流へ差し戻す（resolve は決定的であり続ける）。

## 2. 入力契約 (consumes)

resolve の唯一の入力は **`IssueSource`**——複数 lane を正規化した uniform な版固定オブジェクト。可変参照
（gitSha 無し）は受け取らない（RSLV-FR-010）。`?` 付きは任意（lane により欠ける）。

> **記法 `path@gitSha` の定義**: 「その `path` のファイル**内容を git の版で固定したスナップショット**」を指す。
> **ファイル粒度であり、行や AC を指すポインタではない**（git に行/AC 単位のハッシュは存在しない）。ファイル内の
> 特定 AC は `AC-ID` でキー引きし、AC 単位の内容同一性・drift 判定は `acFingerprints`（behavior + verification
> の自前ハッシュ）が担う。`gitSha` は **blob SHA**（ADR-0001 D8 で確定・§9 外部依存）。

**永続 `IssueSource` は ref（`path@gitSha`）を持つが、resolve コアが consume するのは境界で解決された view**
（各 ref の content を inline 展開した `ResolvedSource`。§4 step1 / §6）。この view の具体型は**凍結せず M01 送り**。

```text
IssueSource（版固定・承認済み）:
  issueType:               feature | bug | tech-debt | harness | eval ...（IssueType）
  epicRef?:                {path, gitSha}      任意（targeted/brownfield は null 可。Issue.epicId も nullable）
  narrative:               { productGoal, userStory }   上流が著述（§3 出力へ copy）
  behaviorRef:             {path, gitSha}      AC behavior + severity の SoT
                                               （greenfield = epic spec.md / targeted = issue 票）
  verificationRef:         {path, gitSha}      AC verification の SoT（acceptance.yaml 形）
  acceptanceCriteriaIds[]: この source が宣言する AC-ID 集合
  scope:                   { include[], exclude[] }
  redLines[]
  systemRefs[]?:           {artifact, elementId, gitSha}   任意（greenfield のみ。依存する system 層要素
                                               （architecture.md の ARCH-NNN 等）の版固定参照。`tech_stack` の投影元。
                                               targeted は epic 非経由ゆえ無し）
  tier2SliceRef?:          {path, gitSha}      任意（greenfield のみ。targeted は issue 粒度で既にスライス済み）
  acFingerprints:          AC-ID → 承認時ハッシュ（behavior + verification）。drift gate の基準
  dependsOn[]:             先行スライス/issue（dependsOnSlices。再利用順序）
```

`IssueSource` は **置換ではなく正規化エンベロープ**である: lane 固有の供給物（greenfield は M21 の
`IssueSpawnOrder`、targeted は各 lane の issue 票）を、本層が consume する uniform な形へ各要素を **map** したもの。
`IssueSpawnOrder` の所有・採番は M21 が持ち続け、本層はその 1 要素を `IssueSource` 形に正規化した view を受ける。

lane ごとの `IssueSource` の組み立て元（本層の外。consume するのは正規化後の形のみ）:

- **greenfield**: M21 が IssueSpawnOrder（design-planner.md §3.3）の 1 要素として供給。`behaviorRef` = epic
  spec.md@gitSha、`verificationRef` = acceptance.yaml@gitSha、`systemRefs` = 依存する system 層要素
  （architecture.md の ARCH-NNN 等。`tech_stack` の投影元・ADR-0004 D31）の版固定参照、`tier2SliceRef` = Tier2
  DesignSlice@gitSha、`narrative` = M21 が著す per-slice goal/userStory（§10 決定）、`acFingerprints` =
  ApprovedSpecRef（M20 §3.4）由来。
- **targeted lane（bug/tech-debt/harness/eval 票 + brownfield intake）**: triage / M02 / M10 / M12 が、1 issue
  粒度の票（behavior + verification を M20 と同じ著述形で版固定）を供給。`systemRefs` / `tier2SliceRef` は
  無し（epic 非経由・既に issue 粒度。`tech_stack` を持たない）、`epicRef` は任意（brownfield は合成 epic or null）。
  `narrative` は票が直接持つ。

> **`brownfield` は IssueType ではなく intake lane（source 種別）**。`IssueType`（schema.ts）は
> `feature`（greenfield slice）/ `bug` / `tech-debt` / `harness` / `eval`。brownfield lane が起票する票の
> `issueType` はこの enum のいずれか（典型は `feature` / `bug` / `tech-debt`）を取り、brownfield 自体は
> `issueType` 値ではない。本層は lane を区別せず `IssueSource` として一様に consume する。

前提条件（lane 共通）:

- source の behavior + verification + narrative + scope が **上流で著述・版固定済み**（M05 は著述しない: RSLV-FR-012）。
- greenfield は spec 状態が `contract-approved` で `acceptanceCriteriaIds ⊆ approvedAcIds`。targeted は票が承認済み
  （署名の所掌は起票 lane。本層は `acFingerprints` を gate に使うのみ）。
- 全 AC が `verificationRef` に自動採点 method を持つ（manual 禁止。本層も assert: RSLV-FR-007）。
- `behaviorRef` の AC-ID 集合と `verificationRef` のキー集合が双方向一致（上流が保証）。

## 3. 出力契約 (produces)

`IssueContract`（本仕様が出力契約の正本。[schema.ts](../../../src/domain/schema.ts) L87 は現行実装で、
M01 抽出時に追従させる）。issue には**埋め込まず**、
**resolve 由来の派生物**として生成し M03 → Generator/Evaluator へ渡す。issue 自体は参照のみ保持（D8）。

```text
IssueContract:
  productGoal:        IssueSource.narrative.productGoal（copy）
  userStory:          IssueSource.narrative.userStory（copy）
  scope:
    include[]:        IssueSource.scope.include（copy）
    exclude[]:        IssueSource.scope.exclude（copy）
  acceptanceCriteria[]:                      # AC-ID で 1:1 join
    id:               IssueSource.acceptanceCriteriaIds の各 AC-ID
    severity:         behaviorRef@gitSha[AC-ID].severity
    behavior:         behaviorRef@gitSha[AC-ID].behavior
    verification:
      method:         verificationRef@gitSha[AC-ID].method（自動採点のみ）
      expected[]:     verificationRef@gitSha[AC-ID].expected
  redLines[]:         IssueSource.redLines（copy。greenfield は slice 制約を含み得る）
  tech_stack?:        systemRefs の architecture 要素（ARCH-NNN）から copy（greenfield のみ。targeted は
                      system 非保持ゆえ無し。源泉は system 層 architecture で確定・ADR-0004。zod schema.ts は
                      実装追従で拡張する: §9。現 schema.ts の状態は本仕様の制約ではない）
```

投影規則（**機械 join / copy**・各フィールドの源泉を固定）:

- `acceptanceCriteria[]`: `acceptanceCriteriaIds` の各 AC-ID について、`{id, severity, behavior}` を
  `behaviorRef@gitSha` から、`{verification:{method, expected}}` を `verificationRef@gitSha` から取り、AC-ID で
  1:1 join。
- `productGoal` / `userStory` / `scope` / `redLines`: `IssueSource` から copy（上流が著述。M05 は創作しない）。
- `tech_stack`: `systemRefs` の architecture 要素（ARCH-NNN・system 層）から copy（greenfield のみ。system 無しの
  targeted では出力しない）。M05 は技術決定を**創作せず**版固定の system 要素を運ぶだけ（決定性保持）。

不変条件:

- **決定性（主特性）**: 同一の `IssueSource`（全 Ref が同一 gitSha）からは **byte-identical** な `IssueContract` を
  生成する。再 dispatch・resume でも同一結果。
- **被覆一致**: 出力 AC-ID 集合 == `IssueSource.acceptanceCriteriaIds`。`tier2SliceRef` がある時は、さらに
  `tier2SliceRef.coversAcIds` とも一致（greenfield = 三者一致 / targeted = 二者一致）。不一致は reject。
- **manual 不在**: 全 `verification.method` が自動採点集合（manual 禁止）。
- **schema valid**: zod `IssueContract` を通る。通らなければ reject（schema を緩めない）。ここでの
  `IssueContract` は**本仕様が定める契約スキーマ**であり、schema.ts はこれに追従すべき実装（現 schema.ts に
  未収載のフィールドは「実装が未追従」であって契約からの除外ではない）。
- **派生物**: 出力は SoT ではなく派生物。issue は source refs（`specRef` / `verificationRef` / 設計 refs。各
  `{path, gitSha(blob)}`）+ AC-ID 群 + slice 参照を保持し、契約本体を埋め込まない（D8）。
  resolve は再実行可能（キャッシュ可・再導出可）。

## 4. 振る舞い / 処理フロー

resolve は M03 が dispatch 可能 issue を処理する時点で呼ばれる（ADR-0001 §3 ⑥）。本層は LLM ではなく
**決定的コード**（§6 / §10 決定）。**状態ラベルの書き込みは M03**（本層は契約を返すのみ）。issueType・lane に
**依らず同一処理**（RSLV-FR-011）。

1. **入力受領 / 境界解決**: **境界**が `IssueSource` の全 ref（`path@gitSha`）を content に解決し（git/ファイル
   I/O はここで完結・**コア外**）、`ResolvedSource`（content inline）を resolve コアへ渡す（入力決定性）。
2. **drift gate**: 共有 `fingerprint()`（AUTH-FR-008 と同一純関数）で `ResolvedSource` の各 AC 現ハッシュ
   （behavior + verification）を計算し、`acFingerprints` と比較——**コアに git を入れない**。
   `acceptanceCriteriaIds` に版ズレ（fingerprint 不一致）があれば **resolve せず block** → 層別差し戻し
   （WHAT→著述層 再署名: D17・O4）。本層は再署名しない。
3. **被覆検証**: 出力予定 AC-ID == `acceptanceCriteriaIds` を確認。`tier2SliceRef` があれば
   `coversAcIds` とも一致を確認（無ければスキップ = targeted の二者検証）。不一致は上流 reject（部分 resolve しない）。
4. **投影**: AC join（behavior+severity × verification）→ `acceptanceCriteria[]`。narrative / scope / redLines を
   `IssueSource` から copy。
5. **schema validation**: zod `IssueContract.parse`。invalid は reject（schema を緩めない・正本 §11 /
   planner.ts L69 の精神）。
6. **引き渡し**: `IssueContract` を M03 へ返す → Generator / Evaluator が消費。

異常系・差し戻し:

- **drift（著述層 起因）**: drift gate（step 2）でブロックし WHAT→著述層へ戻す。新規/削除 AC の被覆ズレは
  上流（M20 status 降格 / M21 孤児検知 / targeted 票の再署名）が先に立つため、本層には版固定済みの整合入力のみ
  届く想定。
- **設計不整合（M21 起因・greenfield のみ）**: 被覆三者一致が崩れる、`coversAcIds` に対応する behavior が無い等は
  M21 へ reject。
- **サイズ超過（B5・Generator→M21→M05）**: 実サイズが PR を超えるのは実装後にしか分からないため検知は
  Generator が行い M21 へ feedback、M21 が split 規約（design-planner.md §3.2）で再 split する。本層はサイズを
  判定せず、再 split された新スライスを**再 resolve**するのみ（決定的ゆえ安全）。
- **foundation drift（spawn 後 merge 前・ADR-0003 §5）**: 依存側が被覆不変なら renumber 不要。`dependsOn` 辺の
  追加 + gitSha 更新を受けて**再 resolve**するだけ（決定的ゆえ安全）。
- **遡及修正（merge 後・closed issue）**: drift gate は **dispatch 時にのみ**発火する（step 2）。よって merge 済み
  issue の実装が現 source から乖離しても本層は自動検知しない。AC 不変な編集は fingerprint 不変ゆえ無害だが、
  behavior/verification を変える修正は**再署名 + 追従 issue**を要し、その検知契機（再署名時 gate への一般化）は
  M05 の外（著述層/M03 所掌・README §4.4 で追跡）。

## 5. 機能要件 (FR)

新規採番 `RSLV-FR-xxx`（正本 §11 DEV-PLAN-FR のうち resolve・schema validation 側を D13 に従い本層へ再配分）。

- **RSLV-FR-001 決定性**: 同一 `IssueSource`（全 Ref が同一 gitSha）から byte-identical な `IssueContract` を生成。
- **RSLV-FR-002 AC join 投影**: 各出力 AC = `behaviorRef` の `behavior`+`severity` と `verificationRef` の
  `verification`(method + expected) を AC-ID で 1:1 join したもの。
- **RSLV-FR-003 被覆一致**: 出力 AC-ID 集合 == `IssueSource.acceptanceCriteriaIds`。`tier2SliceRef` がある場合は
  さらに `coversAcIds` とも一致（三者）。不一致は reject（部分 resolve 禁止）。
- **RSLV-FR-004 schema validation**: 出力は zod `IssueContract` を通す。invalid は reject し schema を緩めない。
- **RSLV-FR-005 派生物・非埋め込み**: resolve 出力は SoT でなく派生物。issue は source refs（各
  `{path, gitSha(blob)}`）+ AC-ID 群 + slice 参照のみを保持し、契約本体を埋め込まない（D8）。
- **RSLV-FR-006 drift gate**: `acFingerprints` 照合で版ズレを検知したら resolve せず層別差し戻し
  （WHAT→著述層）。本層は drift を**検知**するのみで**再署名しない**（O4）。
- **RSLV-FR-007 manual 不在 assert**: 全 `verification.method` が自動採点集合であることを assert。manual を含む
  入力は reject（本来 上流が防ぐが本層も二重に守る）。
- **RSLV-FR-008 純投影（判断・状態書き込みをしない）**: 設計判断をせず、源泉に無い値を創作しない。
  状態ラベルを書かない（書き込みは M03）。
- **RSLV-FR-009 サイズ判定をしない（B5 は下流検知）**: 本層は resolve 時に PR サイズを判定しない。実サイズ超過の
  検知は Generator（実装後）が担い M21 が再 split、本層は新スライスを再 resolve するのみ（§5）。
- **RSLV-FR-010 全 Ref 版固定の強制**: `IssueSource` の全 Ref は `{path, gitSha}`。gitSha 無しの可変参照を
  受け取らない。
- **RSLV-FR-011 lane 非依存（uniform IssueSource）**: resolve は `issueType` / lane に依らず同一処理。
  `systemRefs` / `tier2SliceRef` / `epicRef` は任意。slice 無し（targeted）の場合は被覆を source/output の
  二者で検証する。greenfield も targeted（bug/tech-debt/harness/eval 票・brownfield lane）も同じコードパスを通る。
- **RSLV-FR-012 著述は上流・合成しない**: `narrative` / `behavior` / `verification` / `scope` は `IssueSource` が
  供給する。M05 はこれらを copy/join するのみで、自由文や NL から AC・narrative を**合成しない**（決定性保持）。

## 6. 非機能要件

- **決定性 / 冪等性**: 同一 `IssueSource` → 同一出力。再 dispatch・resume・foundation drift の再 resolve でも一致。
- **pure（隔離テスト可）**: resolve コアは `(ResolvedSource, acFingerprints) → IssueContract` の純関数で、
  呼び出しグラフに I/O を持たない（ref→content 解決は境界の責務・§4 step1）。in-memory fixture だけで隔離テスト
  でき、リポジトリを立てる必要がない。drift 判定の `fingerprint()` は **AUTH-FR-008 と共有する純関数**（M01 候補）。
- **実装は決定的コード（LLM でない）**: resolve は join + copy + validation であり判断を含まないため、コードで
  実装する（「Coordinator はコード」と同系。D26 §3「M05 resolve を M03 に畳む等は capability 向上で再考可」=
  mechanical の傍証）。厳格さは **schema validation** に置き、プロンプトに流し込まない（D28）。これにより
  M16 モデル独立性は自動的に充足する。
- **可観測性 / 評価トレース**: 入力（`IssueSource` の各 gitSha）と出力ハッシュを残せば監査・再現が可能。
  `sliceId`（targeted は issueId）/ AC-ID を join キーとして scorecard と紐づけ、設計起因失敗の逆引き
  （M21 §6 C1・M22）に接続する。
- **性能 / コスト**: LLM 呼び出しを持たないため低コスト・低遅延。dispatch のホットパスに乗っても問題ない。

## 7. 不変条件・禁止事項 (red lines)

- spec.md / acceptance.yaml / issue 票 / 設計ファイルを**書き換えない**（read-only consumer。SoT は上流）。
- `IssueContract` schema を**緩めない**。invalid を黙って通さない。
- **設計判断・受け入れ要件の合成をしない**。源泉に無い情報（productGoal を勝手に発明する・NL から AC を起こす等）を
  創作しない。
- **状態ラベルを書き込まない**（書き込みは M03）。
- **drift を黙って resolve しない**（必ず gate を通す）。再署名は人間（著述層）。
- 契約本体を **issue に埋め込まない**（参照のみ・D8）。
- gitSha 無しの**可変参照を受け取らない**（B3）。
- `manual` メソッドを出力に通さない。

## 8. 受け入れ条件 (testable)

- **greenfield**: サンプル（approved spec.md + acceptance.yaml + Tier2 slice）を同一 gitSha 群で resolve でき、
  出力が zod `IssueContract` を通る（例: octolink `stake/` 相当の 1 スライス）。
- **targeted**: Tier2 slice を持たない bug 票（behavior + verification を版固定）を resolve でき、被覆が
  source/output の二者で検証され、`IssueContract` を通る（slice 必須でないことを検証）。
- 同一 `IssueSource` で 2 回 resolve → **byte-identical**（決定性）。
- 出力 AC-ID 集合 == `acceptanceCriteriaIds`。`tier2SliceRef` ありの不一致サンプルは reject される。
- behavior を 1 つ変更（drift）→ `acFingerprints` 不一致を検知し、resolve せず差し戻す。
- `verificationRef` に `manual` を混ぜたサンプル → reject（本来 上流が防ぐが本層も assert）。
- 出力が issue に埋め込まれず、issue は source refs + AC-ID 群（+ greenfield は slice 参照）のみを保持する。
- resolve が状態ラベルを書かないことを検証できる。

## 9. 既存実装とのギャップ / 移行方針

- [agents/issue-planner.md](../../../agents/issue-planner.md): 「設計 + 分解 + 契約生成」一体 → **分割**。
  設計判断（Tier1/Tier2・分解）は M21 へ（design-planner.md §9）、**resolve（機械投影）のみ**本 M05 へ。
  旧プロンプトは M21/M05 へ分割転記して廃止する。
- [src/planning/planner.ts](../../../src/planning/planner.ts): seed YAML から contract を直接生成する
  `planFromSeed` を**置換**。`IssueSource → resolve` に組み替える。`SeedRoadmap` schema は廃止 / 再定義
  （M20 §9 と連動）。schema validation（L69）の「invalid は緩めず落とす」精神は継承。
- **targeted lane の供給元**: bug/tech-debt/harness/eval/brownfield の `IssueSource` は triage / M02 Hermes /
  M10 Eval Curator / M12 Harness Analyst が emit する。これらは epic spec.md を経由せず、M20 と同じ著述形
  （behavior + verification を版固定）で 1 issue 粒度の票を起票する。本層はその正規化済み `IssueSource` を
  consume するのみ（lane 個別の起票 spec は各モジュール側）。
- [src/domain/schema.ts](../../../src/domain/schema.ts): `Issue.contract` 埋め込み（L108）→ source refs 参照へ
  （D8・M18/M21 と連動）。resolve 出力は派生物として別管理（キャッシュ or 一時。§10）。
- **IssueContract schema 差分**（README §3 差分注意）: 正本には `tech_stack` と `verification.steps` があるが
  zod schema に無い。`tech_stack` の**源泉は system 層 architecture 要素で確定**し（ADR-0004）、`IssueSource.systemRefs`
  経由で copy 投影する（§2/§3）。残るは zod への収載と命名（camelCase / snake_case）統一、および
  `verification.steps` の採否で、M01 抽出時に確定する（README §4.4 で追跡）。
- **brownfield の grader bootstrap（本層の外）**: 既存プロジェクトに自動採点インフラ（playwright/api_test 等）が
  無い場合、最初の票は「test harness を立てる」infra/harness 系になり得る。これは grader 整備の問題で M07/M09 の
  所掌。M05 は「version した verification を join するだけ」で、grader の有無は判定しない。

**外部依存（M05 の設計は確定。以下は owner 側で確定 / 追跡する）**:

- **per-slice narrative**（greenfield の `productGoal` / `userStory` 源泉）: M21 `DesignSlice.narrative` で
  **確定済**（[design-planner.md](design-planner.md) §3.2）。M05 はこれを copy する（§3）。
- **`gitSha` = blob SHA**（決定性 RSLV-FR-001 の前提）: **ADR-0001 D8 で確定済**
  （[decisions/0001](../decisions/0001-authoring-execution-split.md) §8・2026-06-18 補足）。
- **schema.ts 追従 / M18 永続 / 遡及 impact gate / 上流 pinned+signed / targeted 起票 spec**: owner 未 spec の
  cross-module open として **[README](../README.md) §4.4** で一元追跡（各 owner の起票時に回収）。

## 10. 未決事項 / 決定ログ

決定済（ADR-0001）: D8 参照渡し・gitSha drift / D10 粒度 β / D13 M05 = resolve 縮小・M21 分離。
ADR-0003: D26 contract altitude / D28 薄い実装層（resolve = コード・厳格さは schema validation に置く）/
D29 foundation drift（spawn 後 merge 前は `dependsOn` 辺追加 + gitSha 更新で再 resolve・§5 表）。

本セッション決定（2026-06-17）:

- **resolve = 決定的コード（LLM でない）**。全出力フィールドが版固定の `IssueSource` から join / copy で導出でき
  判断を要さない（要するなら上流の欠落）。D28 / D26 §3 に整合し、M16 モデル独立性も自動充足。
- **drift は検知して差し戻すのみ・再署名はしない**。再署名は人間（著述層・O4）。本層は dispatch 時の gate。
- **lane 非依存の uniform `IssueSource`（§2）**: greenfield 分解と issue 粒度の票（bug/tech-debt/harness/eval 票
  および brownfield lane）を同一の `IssueSource` に正規化し、`systemRefs`/`tier2SliceRef`/`epicRef` を任意化。M05 を**全 lane 共通の
  resolve + validation コア**に確定。被覆は slice 有無で三者/二者に degrade。理由: スキーマが既に bug/tech-debt/
  harness/eval を持ち、M10/M12 が epic を経由しない issue を生むため、resolve を greenfield 専用にすると
  これらが契約に乗らない（B 級・変更コスト高ゆえ今確定）。
- **productGoal / userStory / scope の源泉 = `IssueSource` 供給必須**（旧 open を解消）: narrative / scope は
  resolve が著述せず source から copy する。greenfield では **M21 が per-slice narrative を著す**（design-planner.md
  §3.2 DesignSlice に narrative フィールドの追加が要る・cross-module 調整・M21 確定時に反映）、targeted では票が
  直接持つ。これにより「epic 粒度の自由文を純機械 join に乗せられない」問題が、authoring を上流へ寄せることで
  消える（決定性を保つ）。
- **standalone の閉じ方 = 境界 pre-resolve + 共有純粋 `fingerprint()`（`SourceResolver` port は採らない）**:
  resolve コアを `(ResolvedSource, acFingerprints) → IssueContract` の純関数とし、ref→content 解決は境界
  （コア外）に出す（§2/§4 step1/§6）。injectable port は I/O を呼び出しグラフに残し mockable 止まりで、pure・
  非 service の 2 目標を裏切る。pre-resolve + `fingerprint()` 共有は pure・隔離テスト・DRY（AUTH-FR-008 共有）を
  少ない機構で同時に満たす。型の universal 化（`ResolvedSource`/`IssueSource`）と独立サービス化は据え置き。
- **fingerprint フィールド名 = `acFingerprints` に統一**（旧 `approvedFingerprints` を改名）。M20 AUTH（authoring-layer.md）
  / README と同名にし、§6 の共有純関数 `fingerprint()`（= AUTH-FR-008）と命名を揃える（DRY・別名による wiring
  ズレを回避）。
- **`tech_stack` の源泉 = system 層 architecture 要素（`systemRefs` 経由）**（2026-06-18 改訂・ADR-0004 で
  二層 spine が三層へ解体されたことに追従）。`IssueSource` に `systemRefs[]?` を持たせ、M05 が architecture 要素から
  `tech_stack` を copy 投影する（greenfield のみ。targeted は system 非保持）。M05 は技術決定を創作せず版固定の
  system 要素を運ぶのみ。zod への収載・命名統一は M01 抽出時（§9）。
- **B5 サイズ超過は M05 が判定しない（検知は下流）**。実サイズは実装後にしか確定しないため、検知は Generator、
  再 split は M21、本層は新スライスを再 resolve するのみ（§5 foundation drift と同経路）。理由: resolve 時に
  「実サイズ」を知る決定的メトリクスが無く、閾値判定は「決定」混入で pure 性を壊し M21 の分解と二重持ちになる。
- **`brownfield` は IssueType でなく intake lane**。`IssueType`（schema.ts）は `feature`/`bug`/`tech-debt`/
  `harness`/`eval`。brownfield lane が起こす票の `issueType` はこの enum のいずれかを取り、brownfield 自体は
  値ではない（§1/§2）。schema 変更不要。

本セッション決定（2026-06-18）:

- **契約の SoT は本仕様（正本）・schema.ts は追従実装**。`tech_stack` は契約に収載済み（源泉 = system 層 architecture・§3）。
  現 zod schema.ts に未収載なのは「実装が未追従」であって契約からの除外ではない。zod 収載・命名統一は実装追従
  タスク（§9）。残るは `verification.steps` の採否のみ（M01 確定）。「今の実装に縛られない」方針を明文化。
- **M05 の gate 所掌 = dispatch 時のみ**を明文化。再署名時 impact gate（遡及検知の一般化）は著述層/M03 の所掌で
  M05 の外。本層は fingerprint diff の純機構を供すに留める（§4 異常系・README §4.4 で追跡）。
- **blob SHA を M05 の決定性 hard requirement として上げる**（RSLV-FR-001 の前提・ADR-0001 D8 で確定）。

残 open: **なし**。M05 自身の未決は無く設計は確定。cross-module 依存は §9「外部依存」で参照し、owner 未 spec の
申し送りは README §4.4 で一元追跡する（#1 narrative は design-planner §3.2、#7 blob SHA は ADR-0001 D8 で解決済）。

**M01 抽出候補（loop 1 通過後・README §8）**: `IssueSource` / `ResolvedSource` / `IssueContract` の共通 envelope・
version-pinned Ref 形・AC-ID 規約、および純粋 `fingerprint()`（M05 drift gate ↔ M20 AUTH-FR-008 の共有関数）は
M01 共通契約モデルへ抽出する候補。先に固定しない（ADR-0001 D1）。
