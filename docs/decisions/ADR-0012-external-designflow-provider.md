# ADR-0012: UX/UI設計を独立したDesignflow Providerへ分離する

- 状態: 採択（2026-07-25。CISO-03/05で契約bootstrapとDashboard固有gateを実証済み、
  汎用workflow intake adapter未実装）
- relates:
  - ADR-0002（Published Language）
  - ADR-0008（GitHub Issue intake）
- preserves:
  - 人間がWHATと承認を所有する
  - 決定論コードがagent出力を検証してからqueueへ投影する
  - workflowのstoreを実行状態のSoTとする

## 文脈

現行A7はfrontend/fullstackの`EnrichmentCandidate`ができた後に専用UI designerを起動し、
`UiDesignArtifact`をIssueへ添付する。これにより実装者とreviewerへ共通のUI契約を渡せるが、次を扱えない。

- ページ目的・利用者タスク・労力上限・視認順序から要件を再構成する
- 全表示物と配置について「何の目的に寄与し、除くと何が壊れるか」を説明する
- feature内の部品追加と共有design systemの変更を区別し、再利用判断を蓄積する
- 設計previewを人間が確認し、特定revisionを承認または差し戻す
- 画面設計から発見したbackend capabilityを、最終Issue Contract/API設計へ戻す

特に現在の順序では、plannerが最終Issue Contractを作った後にUI設計を行うため、UIで必要になったquery、
command、権限、freshness、idempotency、failure semanticsをbackend計画へ安全に反映できない。

## 決定

### 独立した製品境界

UX/UI設計を`workflow`内部personaの詳細ではなく、単体で利用可能な**Designflow Provider**として分離する。
公開元は`mrbaron3/designflow`とし、別runtime・別deploymentになっても公開契約を保つ。

providerは次を所有する。

- Design Request
- Experience Contract（page purpose、task、flow、effort budget、visibility/attention、各elementのrationale）
- Design System Delta（reuse/extend/create/feature-localの判断、token/component/pattern）
- Capability Requirements（UXがbackendへ要求する能力。HTTP endpointの形は所有しない）
- review可能なpreview
- revisionとcontent digest
- digestへ束縛したHuman Design Decision

`workflow`はSource Issue、要求trace、最終Issue Contract、API/実装分解、実行・評価・releaseを所有し続ける。
両者はDB、内部class、agent prompt、filesystem layoutを共有しない。

### Published Languageと版固定

境界はversioned JSON Schemaを正本とする。成果物はcontent-addressedなDesign Bundleとして交換し、
`workflow`はschema、digest、cross-reference、人間decisionを決定論検証する。

承認は`revisionId`と`bundleDigest`の組に対してのみ有効とする。承認後にartifactが変われば再承認が必要である。
raw JSONだけを人間の審査面にせず、同じbundleから生成したpreviewと次を提示する。

- ページ目的と成功条件
- primary taskと労力budget
- attention hierarchy
- 全elementのplacement rationale / removal impact
- design system delta
- backend capability delta
- 前revisionとの差分と未解決ambiguity

### workflowの処理順

frontend/fullstackを含む要求は次の順で処理する。

1. intakeがSource Snapshotと要求traceからDesign Requestを構成する
2. providerがrevisioned Design Bundleを生成する
3. 人間がpreviewを確認し、approve / request-changes / rejectを記録する
4. approve済みbundleのCapability Requirementsをplannerへ戻す
5. plannerがfrontend/backendのIssue Contractとsystem/API設計をreconcileする
6. trace・schema・digest・decision・capability coverageが全て通った場合だけexecution queueへ投影する

したがって「UI artifactを既に確定したCandidateへ後付けする」現行順序は移行後の標準経路にしない。

### 移行

- 現行`UiDesignArtifact`と`ui-design` routeは即時削除せず、legacy provider adapterとして扱う。
- 最初は固定contract fixtureを返すin-memory/file adapterでDesign Bundleを受け、Designflow processや
  remote serviceをworkflowの開発・testに必須としない。
- 新旧artifactをdual-writeしない。1 candidate/revisionにつき選択されたproviderは1つだけとする。
- backend-only要求はExperience Contract gateを要求しない。
- provider不達、schema不正、digest不一致、ambiguity残存、decision不在、capability未反映は
  `needs-human-review`へfail-closedする。

### CISO-03/05で得たbootstrap baseline

CISO-03/05は本ADRの標準intake配線より先に、固定contractをControl API／Dashboardの実装gateとして
grounded実走した。これは後続taskが再実装せず再利用するbaselineである。

- `contracts/designflow/contract-v1.0.0-rc.1/`にprovider provenance、schema、example、digest fixtureをpinした。
- `internal/designgate/`がschema、artifact／bundle digest、human decision、ambiguity、
  Capability RequirementsとOpenAPI operationの完全性をfail-closedで検証する。
- CISO-05はDesign Request→request-changes→revision 2のdigest-bound approve→7 capabilityの
  reconciliation→Dashboard実装→Playwright／UX／a11y evidenceを同一lineageで実証した。

ただし現行gateはCISO Dashboardのapproved digestとreconciliationをcompiled trust anchorとして持つ。
Source IssueからDesign Requestを作る汎用port、draft→design→final planning、candidate単位provider選択、
bundleからの人間向けprojectionは未実装である。したがってCISO evidenceはADRの成立証拠だが、
WF-DF-001..008の標準workflow consumer完了を意味しない。

### 並行開発

- workflow taskは固定されたcontract releaseとfixtureだけへ依存し、DesignflowのIssueやruntime完成を待たない。
- Designflow taskはworkflowのadapter、Issue、API、Dashboardを依存先にしない。
- 各repositoryは独立したIssue DAG、test、release cadenceを持つ。
- live統合は両者のblack-box conformanceであり、どちらかの内部実装taskにしない。

### runtime言語

providerのruntimeは公開契約から独立した別判断とする。MoonBit/Go/Rustの選択を先に固定せず、
v1 conformance fixturesと人間review vertical sliceを実装してから、配布性、schema tooling、UI integration、
運用複雑度の実測で決める。`workflow` adapterはruntime固有SDKへ依存しない。

## 帰結

- ＋ `designflow`はCLI/HTTP/任意consumerから単独利用できる。
- ＋ UX判断が最終API/Issue分解より前に入り、frontend起点のbackend要件を失わない。
- ＋ 人間は見える成果物と差分を審査し、承認対象をdigestで特定できる。
- ＋ design systemの再利用判断と、全表示物・配置の根拠を検証可能なデータとして残せる。
- − planningをdraft→design→reconcileへ分ける必要があり、現行`PlanningEnrichmentOutput`はそのままでは足りない。
- − preview sandbox、identity、artifact retention、provider availabilityが新しい運用責務になる。

## system層への吸収

| premise | 吸収先 |
| --- | --- |
| 外部providerと公開語彙 | `LANG-intake-013..018` / `ARCH-intake-014` |
| design-first reconciliation | `DOM-intake-017..019` / `ARCH-intake-015..016` |
| digest-bound human decision | `DOM-intake-020` / `DATA-intake-010..012` / `ARCH-intake-017` |
| legacy移行・fail-closed | `DOM-intake-021` / `ARCH-intake-018` |
