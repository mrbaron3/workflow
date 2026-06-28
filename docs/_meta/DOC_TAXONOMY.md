# ドキュメント分類（理想形）

> 仕様駆動 × AI 自律開発で **生成されるべき文書の理想的な分類・ID 体系・階層** を定める参照。
> 「この内容はどのビューの・どの高度の文書に属するか」で迷ったらここを引く。
> [DOC_LIFECYCLE.md](DOC_LIFECYCLE.md) が **時間モード（delta/state・SSOT/派生）** を定めるのに対し、
> 本書は **関心 × 高度 × ズーム** で文書そのものの理想形を定める（対の関係）。
> 汎用（特定システムに縛られない）。規模に応じて §ダイアル で増減する。

- 種別: harness / reference
- 状態: 確定（理想形・汎用）
- 最終更新: 2026-06-28
- 関連: [NORTH_STAR.md](../NORTH_STAR.md) / [DOC_LIFECYCLE.md](DOC_LIFECYCLE.md) / [ARCHITECTURE.md](../ARCHITECTURE.md) / [GLOSSARY.md](../GLOSSARY.md)

## 理想を貫く3つの軸

文書は1次元の階層ではなく、直交する3軸の格子で位置づける。

| 軸 | 何を分けるか | 値 |
|---|---|---|
| **関心（concern）** | 何について語るか | 言語 / ドメイン / 構造 / データ / 契約 / 品質 / 決定 |
| **高度（altitude）** | どのスコープか | macro（system 全体）→ micro（1機能）→ nano（1 PR） |
| **ズーム（zoom）** | macro 内の詳細度 | 構造＝文脈→コンテナ→部品 / データ＝概念→論理→物理 |

原則: **直交する関心ごとに単一責務の文書**を置き、ID とクロス参照で織る。単一文書で全部を語らない
（アーキ文書理論 4+1 views / arc42 の核心）。macro 自体もズームで階層を持つ。

## 2本の木（spec で交わる）

文書は **2本の独立した木**を成し、**feature（= 署名 spec）** で交わる。

```text
【計画の木】intent/delta — 何を・どの順で・なぜ作るか
  North Star → Roadmap(vision/principles/順序付き epic) → Epic(束) → Feature ─┐
                                                                                ├─► 署名 spec（交点）
【system の木】state/SSOT — システムが何で「ある」か                          ┘
  Context Map → 境界ごと7ビュー（言語/ドメイン/構造/データ/契約 +横断 +ADR）
```

- **計画の木**は「やりたいこと」を**署名可能な capability（= feature）まで分解**する（roadmap-planner の仕事＝
  outcomes と順序だけ・AC は書かない）。**system の木**は「システムが何であるか」を境界ごとに積む。
- **spec はこの交点**：計画の木の葉であり、同時に system の木を `dependsOn` で参照する。
- **Epic は著述単位でない**（grouping。1 spec ≠ 1 epic）。1 Epic の下に複数 Feature(=spec)。

### spec の粒度上限と分解

`spec` は granularity-independent だが**無制限ではない**。上限は **1つの凝集した・人間が署名できる capability**。

| 要求の例 | 扱い |
|---|---|
| 「タスクに有効期限を追加」 | 上限内 → **1 spec**（`specs/task-due-date/`） |
| 「Todo アプリを作りたい」 | capability の portfolio で上限超過 → **計画の木（roadmap）が feature 群に分解** → feature ごとに to-spec → `specs/task-crud/`・`specs/task-due-date/` …。**1つの巨大 spec にしない** |

製品スケールの要求は「1つの spec」ではなく「**複数の署名 spec ＋ それを畳んだ feature-catalog**」になる
（分解は roadmap、清書＝GWT・署名は to-spec、と層が割れる）。

## MACRO — 7つの直交ビュー（境界コンテキスト単位）

境界コンテキスト（bounded context）を macro の組織単位とする。コンテキスト局所のものは `_system/<ctx>/` に、
system 横断のものは外に出す。各ビューは additive な ID 空間を持つ（renumber/rewrite 禁止・追加のみ）。

| # | ビュー | 文書 / 単位 | ズーム階層 | ID | 何を確定するか |
|---|---|---|---|---|---|
| 1 | **言語** | `ubiquitous-language.md`（**コンテキスト局所**） | 用語 | `LANG-<CTX>-NNN` | 全文書が書かれる語彙。境界ごとに別物 |
| 2 | **ドメイン**（DDD 戦術） | `domain-model.md` | 集約→エンティティ→VO ／ 不変条件・ドメインイベント・方針・状態機械 | `DOM-<CTX>-NNN` | 概念と、それを縛る業務ルール |
| 3 | **構造**（C4/arc42） | `architecture.md` | 文脈(L1)→コンテナ(L2)→部品(L3) ＋ 実行/配置ビュー・seam | `ARCH-<CTX>-NNN` | 分割・依存・seam・配置 |
| 4 | **データ** | `data-model.md` | 概念→論理→物理(DDL/migration) | `DATA-<CTX>-NNN` | 永続化される状態の形 |
| 5 | **契約**（published language） | `contracts/`（OpenAPI / AsyncAPI 等） | endpoint / event / message | `CONTRACT-<CTX>-NNN` | コンテキスト間・外部との公開境界 |
| 6 | **品質**（NFR/横断） | `cross-cutting/*.md`（system 横断） | セキュリティ / 可観測性 / 性能SLO / エラー方針 | `NFR-NNN` | 「どれだけ良く」振る舞うか |
| 7 | **決定**（ADR） | `decisions/ADR-NNNN.md`（append-only・supersede 可） | 1決定=1ファイル | `ADR-NNNN` | **なぜ**そうなっているか（不変の履歴） |

**索引 = コンテキストマップ**（keystone・macro の入口）:

- `context-map.md` … 全境界コンテキストの一覧と**関係**を DDD の関係パターンで明示：
  Partnership / Shared Kernel / Customer-Supplier / Conformist / **ACL（腐敗防止層）** / Open-Host Service /
  Published Language / Separate Ways。「どの境界がどの言語で話し、どこで翻訳されるか」を1枚にする。

注意点（理想の肝）:

- **言語はグローバル1冊にしない。** 語は境界で意味が変わる（"Order" は注文文脈と配送文脈で別物）。
  per-context の言語 ＋ コンテキストマップで翻訳点（ACL）を名指す。
- **list が落としがちな3つ（契約・NFR・ADR）こそ AI 自律開発で効く。** 契約は seam を機械検証可能にし、
  NFR は grader の母体、ADR は「なぜ」を蒸発させない。

## MICRO — 機能ごとの仕様書

macro を**参照**し、自分は behavior（AC）だけを足す。状態・スキーマを spec に書かない（書いた瞬間に SSOT が
二重化して drift する。[DOC_LIFECYCLE](DOC_LIFECYCLE.md) §著述 SSOT は2つだけ と一貫）。

```text
feature spec（理想の節構成）
├─ 同定         id / title / 所属コンテキスト / status(draft→signed→implemented)
├─ 意図         user story（誰が・何を・なぜ）/ 価値 / north-star・roadmap へのリンク
├─ スコープ     in/out / 事前条件 / 前提
├─ 挙動         受け入れ基準 = GWT シナリオ群（各に安定 AC-ID）
│               happy だけでなく error / resilience / boundary / concurrency を必須化
├─ 参照(複製禁止)  LANG / DOM / DATA / CONTRACT / NFR の ID を dependsOn として指す
├─ レッドライン  決して壊してはならない不変条件
├─ supersedes   この AC が置換する過去 AC-ID（= 現在仕様を畳む鍵）
└─ 採点(別ファイル) acceptance.yaml: AC-ID → verification(method + expected)
```

ID: `AC-<SPEC>-NNN`。micro は macro を「持たない・指す」。

## NANO と DERIVED

- **NANO**: **Issue Contract**（store の実行レコード・**著述文書でない**）。`to-detail-design` が署名 spec を
  PR サイズの Issue に分解して生成し、`coversAcIds` / `dependsOnSystem` / seam の `implementationNotes` は
  **issue のフィールド**になる。被覆×排他は「**この spec から spawn された issue 集合**」で検査する
  （markdown の slice 文書は持たない。ARCHITECTURE「state lives in Issues/PRs, not docs」と一貫）。
- **DERIVED（一切著述しない・[DOC_LIFECYCLE](DOC_LIFECYCLE.md) 案A）**:
  - `feature-catalog.md` … 現在成り立つ AC を畳んだ「アプリの現在仕様」（micro 状態の派生ビュー）。
  - 図一式 … コンテキストマップ図 / C4 図 / ER 図 / シーケンス図（構造化 SSOT から生成）。
  - `traceability.md` … north-star → feature → AC → slice → PR → evidence の追跡表。

## 理想のツリー

```text
docs/
  NORTH_STAR.md                      # 頂点の意図（計画の木の頂点）
  roadmap.yaml                       # 計画の木：vision/principles/順序付き epic→feature
  context-map.md                     # ★macro 索引：境界コンテキスト + 関係パターン
  cross-cutting/                     # macro・system 横断（品質ビュー）        NFR-NNN
    security.md  observability.md  performance-slo.md  error-handling.md
  decisions/                         # ADR（append-only・supersede 可）         ADR-NNNN
    ADR-0001-*.md
  _system/<context>/                 # macro・境界コンテキスト単位
    ubiquitous-language.md           # LANG-<CTX>-NNN（言語：局所）
    domain-model.md                  # DOM-<CTX>-NNN（集約・不変条件・イベント・状態機械）
    architecture.md                  # ARCH-<CTX>-NNN（文脈→コンテナ→部品・seam）
    data-model.md                    # DATA-<CTX>-NNN（概念→論理→物理）
    contracts/                       # CONTRACT-<CTX>-NNN（公開言語）
      api.openapi.yaml  events.asyncapi.yaml
  specs/<feature>/                   # micro・機能単位（= 計画の木の葉）
    spec.md                          # AC-<SPEC>-NNN（GWT・WHAT）
    acceptance.yaml                  # AC → verification
                                     # nano（slice）は文書でなく store の Issue（下記 NANO 参照）
  _derived/                          # 生成物（著述しない）
    feature-catalog.md  diagrams/  traceability.md
```

## ID 体系（additive・横断索引）

| ID | 単位 | 住処 | 性質 |
|---|---|---|---|
| `LANG-<CTX>-NNN` | 用語 | `_system/<ctx>/ubiquitous-language.md` | additive |
| `DOM-<CTX>-NNN` | ドメイン要素 | `_system/<ctx>/domain-model.md` | additive |
| `ARCH-<CTX>-NNN` | 部品/seam | `_system/<ctx>/architecture.md` | additive |
| `DATA-<CTX>-NNN` | エンティティ/テーブル | `_system/<ctx>/data-model.md` | additive |
| `CONTRACT-<CTX>-NNN` | endpoint/event | `_system/<ctx>/contracts/` | additive |
| `NFR-NNN` | 品質要件 | `cross-cutting/` | additive |
| `ADR-NNNN` | 決定 | `decisions/` | append-only・supersede |
| `EPIC-NN` | 計画 grouping | `roadmap.yaml` | additive |
| `AC-<SPEC>-NNN` | 受け入れ基準 | `specs/<feature>/spec.md` | additive・supersede |
| Issue Contract | 実行単位（旧 slice） | **store**（Issues/PR/db） | 実行状態・著述でない |

micro の AC が macro の ID を `dependsOn` で指すことで、「この機能はどのドメイン規則・どのテーブル・どの契約に
依存するか」が機械的に辿れる ＝ 評価・回帰・影響分析の母体（北極星「証拠で評価・改善」）。

## 理想を成立させる2つの構造原則

1. **構造化ソース ＋ 派生スキン。** 各ビューの核（エンティティ・フィールド・契約）は**構造化データ
   （YAML/スキーマ）を SSOT** にし、人間可読 prose と図はそこから derive する（論理データモデル→ER 図、
   OpenAPI→API ドキュメント、ドメイン→コンテキスト図）。判断（不変条件の根拠・語の定義・ADR）は prose のまま
   著述。ハーネスの「Diagrams are derived downstream」を全ビューへ一般化したもの。
2. **安定 ID ＋ クロス参照 = トレーサビリティ。** 全要素に additive な ID を付け、参照で繋ぐ（複製しない）。

> 理想の純度は「**著述する SSOT は薄く、派生物は厚く**」で測れる。人手で書くのは判断（語・規則・契約・決定・AC）
> だけ。状態・図・現在仕様・追跡表はすべて生成。これが drift をゼロに保ちつつ豊かな出力を得る唯一の構造。

## データビューの実体化：構造化スキーマ → ER 図（構造原則1 の適用）

> 構造原則1「構造化ソース＋派生スキン」を **データ（`DATA-<CTX>-NNN`）** に落とした harness 既定。
> SSOT は **スキーマ DSL**、ER 図はその派生。要件「**無料・プロジェクト数無制限**」がツールを縛る。

| 層 | 採用 | 理由 |
|---|---|---|
| **構造化 SSOT（著述）** | **DBML**（schema DSL） | table/column/型/PK・FK/enum/index を表現し関係を1級で持つ。`@dbml/cli` で SQL DDL と相互変換。言語自体は MIT・無料 |
| **派生・既定ビュー** | **Mermaid `erDiagram`** | GitHub/GitLab/VS Code/Obsidian が**ネイティブ描画**＝インフラ・アカウント・上限ゼロ。PR 差分で図が見える常設ビュー |
| **派生・リッチ確認（必要時）** | **DrawDB**（ブラウザ完結）／**自己ホスト Azimutt**（大規模・関係追跡） | DBML/SQL を import しドラッグ操作・探索。共に無料・無制限（OSS） |

**なぜ SaaS でなく上記か**：無料×無制限という要件がホスト型を落とす（dbdiagram.io＝無料10図 / ChartDB
cloud＝DB1・テーブル10 / Azimutt cloud＝1プロジェクト）。残るのは「リポジトリ内描画の text 図」と「OSS
（自己ホスト／ブラウザ完結）」のみ。**DBML はビューアに保存し続けない限りロックインしない**（format は自由、
hosted viewer だけが有料）。判断（不変条件・migration の根拠）は prose のまま、図は derive
（[DOC_LIFECYCLE](DOC_LIFECYCLE.md)「Diagrams are derived downstream」）。

```text
data-model.md の DBML  ──┬─► Mermaid erDiagram（data-model.md 内 / _derived/diagrams/）
（構造化 SSOT・著述）     ├─► SQL DDL（@dbml/cli）
                          └─► import → DrawDB / Azimutt（リッチ探索）
```

## ダイアル（規模に応じた右サイズ化）

7ビュー全部が常に要るわけではない。**不変なのは構造（関心ごとに単一責務・参照で繋ぐ・薄い著述／厚い派生）**で、
ファイル数ではない。

| 規模 | 取り方 |
|---|---|
| **単一サービス・小規模** | 境界1つ／契約はアーキに内包／NFR は1ファイル／ADR は軽量 |
| **複数境界・中大規模** | 7ビュー＋コンテキストマップをフル稼働／契約・NFR を first-class 化 |

## 現状からの差分（参考・本書は理想形）

実装の追従先。今の `to-system-design` は言語をドメインに内包（`domain-map.md`）し、`architecture.md` /
`data-model.md` を持つ。**未 first-class**: 契約（CONTRACT）／NFR 横断（cross-cutting）／ADR（decisions）／
コンテキストマップ索引／派生ビュー（feature-catalog・traceability）／`supersedes` 機構
（[DOC_LIFECYCLE](DOC_LIFECYCLE.md) で前方参照済み）。
**要修正**: `to-detail-design` は現状 `slices/*.md` を著述するが、本書の方針では **Issue を生成**して store に
着地させる（slice 文書は廃し、被覆×排他は issue 集合で検査）。

## 下敷きにした枠組み

DDD 戦略（ユビキタス言語・境界コンテキスト・コンテキストマップ）／DDD 戦術（集約・ドメインイベント・不変条件）／
C4 model（文脈→コンテナ→部品）／arc42（横断・実行・配置ビュー）／ADR（決定の append-only 記録）／
データモデリング（概念→論理→物理）／契約（OpenAPI・AsyncAPI）／Diátaxis（文書種別の分離）。
