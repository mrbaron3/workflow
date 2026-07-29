# Designflow consumer実装ハンドオフ

- 更新日: 2026-07-28
- 状態: WF-DF-001..008の汎用workflow consumerを作業ツリー内で実装し、
  CISO golden replayとprovider-neutralな標準intake headless E2Eを完了。
  remote Designflow／live GitHub／実支援技術・端末のblack-box実証は未実施
- 判断: [ADR-0012](../decisions/ADR-0012-external-designflow-provider.md)
- 公開境界: [`mrbaron3/designflow`](https://github.com/mrbaron3/designflow)の
  `contract-v1.0.0-rc.1`
- workflow tracking Epic: [#24](https://github.com/mrbaron3/workflow/issues/24)
- GitHub反映: [親#10](https://github.com/mrbaron3/workflow/issues/10)、
  [#13](https://github.com/mrbaron3/workflow/issues/13)、
  [#15](https://github.com/mrbaron3/workflow/issues/15)

## 目的

frontend実装前に承認済みDesign Bundleを読み、UIから導かれたbackend capabilityを最終API/Issue計画へ
反映する。workflowはDesignflowを実装・起動・運用せず、固定contract releaseのconsumerとしてだけ振る舞う。

## 既にmainへ入ったbaseline（再実装しない）

PR #34の計画後、CISO-03/05が次を`main`へ着地させた。

- `contracts/designflow/contract-v1.0.0-rc.1/`: provider provenance、schema、example、digest fixture。
- `internal/designgate/`: schema、artifact／bundle digest、human decision、ambiguity、
  capability coverage、OpenAPI operation対応を検証するGo gate。
- `evidence/ciso-05/design/`: Source Issue #15、Design Request、request-changes revision、
  digest-bound approve、7 capability reconciliation、preview、UX/a11y/Playwright evidence。

このbaselineはcontractと判断の実行可能性を証明した。一方、この時点のgateはCISO Dashboard固有の
approved digest、reconciliation path、Issue/ACをtrust anchorとしており、`src/intake`の標準経路には
接続されていなかった。2026-07-28の汎用実装は既存fixtureとnegative testを共有し、CISO固有定数を
production経路へコピーせずにこの制約を解消した。

## 2026-07-28 ローカル実装結果

- pinned contract consumer、lock metadata、in-memory/file provider portを実装した。
- frontend/fullstack planningをDesign Request draftで停止し、明示provider選択、digest-bound human gate、
  review projection、capability reconciliationの完了後だけIssueを原子的に作る。
- `request-changes`をappend-only履歴へ残し、明示resume後の承認は
  `previousRevisionId`と`supersedesDecisionId`の両方が直前判断へ一致する場合だけ受理する。
- Capability RequirementsをIssue／AC／system element／workflow所有APIへ完全traceし、
  zero、dangling、duplicate、異revision、暗黙fallback、dual-writeをfail-closedにした。
- generatorと全reviewerへ、同じapproved purpose／effort／attention／element rationale／
  design-system／capability projectionを渡す。
- CISO-05の7 capability／9 APIをhistorical golden adapterでreplayした。production builderへ
  CISO固有path、Issue番号、digestの例外分岐はない。
- 無関係な`acme/reporting#73`相当のfullstack Source Snapshotを標準intakeへ通し、
  request-changes→明示resume→revision 2 approve→backend/UI Issue→expected-head merge→releaseを
  fake provider／fake GitHub境界と実headless Chromeで完走した。
- release lineageはsource、request、decision history、bundle、capability edge、全参照Issue、
  merged current PR revision／head、approved gate、Playwright／UX／a11y evidence、releaseを照合する。

検証結果はTypeScript 112 files／942 tests pass（29 skip）、Go 5 packages pass、TypeScript build pass、
`git diff --check` passである。skipのうち27件は外部PostgreSQLを必要とするintegration testで、
今回のDesignflow consumerのローカル受け入れ条件には含めない。

## 並行開発を成立させる境界

- workflow taskはDesignflowのIssue、runtime、DB、CLI完成を依存先にしない。
- 入力は固定tagのJSON Schema、example bundle、digest fixtureだけとする。
- workflow内のfake providerがfixtureを返すため、外部processなしで全gateを実装・テストできる。
- live adapterは同じportの後続追加であり、core planningやqueue projectionを変更しない。
- Designflow側へworkflow固有fieldやlifecycleを要求しない。
- contractのbreaking changeは既存tagを書き換えず、新tagへの明示upgrade Issueとして扱う。

これにより、両repositoryは同じ時点から別のIssue DAGを独立して進められる。

## 所有境界

| Designflow公開contractから読む | workflowが所有する |
|---|---|
| Design Request schema | Source Issue→Design Request変換 |
| Experience Contract | requirement/system trace |
| Design System Delta | target design system適用計画 |
| Capability Requirements | API/system/Issueへのreconciliation |
| Bundle Manifest／digest | artifact取得・digest検証 |
| Human Design Decision | queue前の人間承認gate |
| example／negative fixture | adapterとgateの回帰test |

共有DB、内部型import、agent prompt共有、相手repositoryへの書込みは禁止する。

## workflow独立task DAG

```text
contract-v1.0.0-rc.1
  ├─ CISO baseline: pinned contract + Dashboard-specific gate
  ├─ WF-DF-001 reusable workflow consumer / fixture
  │      ├─▶ WF-DF-002 provider port / fake adapter
  │      └─▶ WF-DF-003 planning draft split
  ├─ WF-DF-004 digest-bound decision gate
  └─ WF-DF-005 review projection

WF-DF-002 + 003 + 004 ─▶ WF-DF-006 capability reconciliation
WF-DF-005 + 006       ─▶ WF-DF-007 legacy migration
WF-DF-007             ─▶ WF-DF-008 standard-intake grounded run
```

WF-DF-001、WF-DF-004、WF-DF-005は同時着手できる。いずれもDesignflow runtimeを必要としない。

## workflow task

| Key | Issue | 実装内容 | workflow内の依存 | 完了証拠 |
|---|---|---|---|---|
| WF-DF-001 | [#26](https://github.com/mrbaron3/workflow/issues/26) | CISO pinを再利用し、Dashboard固有Go gateから独立した汎用workflow consumer／lock metadataを作る | なし | 同じpinned fixtureでvalid/invalidを検証し、別validator実装を増やさない |
| WF-DF-002 | [#27](https://github.com/mrbaron3/workflow/issues/27) | `DesignflowProvider` port＋in-memory/file fake | WF-DF-001 | external processなしのadapter test |
| WF-DF-003 | [#28](https://github.com/mrbaron3/workflow/issues/28) | planning outputをdraft requirementsとfinal Issue Contractへ分離 | WF-DF-001 | backend-only回帰＋UI draft停止 |
| WF-DF-004 | [#29](https://github.com/mrbaron3/workflow/issues/29) | CISO固有compiled digest/pathを除き、任意candidateへ使えるschema/artifact/bundle digest＋Human Decision gateへ抽出 | なし（contract RC＋CISO negative fixtures） | stale approval／digest mutation拒否＋CISO gate回帰 |
| WF-DF-005 | [#30](https://github.com/mrbaron3/workflow/issues/30) | CISO preview/evidenceをgolden入力に、purpose/effort/attention/rationale/capabilityの汎用review projectionを実装 | なし（contract RC直接） | raw JSON不要のsnapshot test |
| WF-DF-006 | [#31](https://github.com/mrbaron3/workflow/issues/31) | CISOの固定#15 reconciliationを一般化し、Capability→API/system/Issue/AC coverageをplanner出力として永続化 | WF-DF-002,003,004 | zero/dangling/異revision拒否＋CISO 7 capability replay |
| WF-DF-007 | [#32](https://github.com/mrbaron3/workflow/issues/32) | legacy `UiDesignArtifact`から明示provider選択へ移行 | WF-DF-005,006 | dual-write／暗黙fallback拒否 |
| WF-DF-008 | [#33](https://github.com/mrbaron3/workflow/issues/33) | CISO-05をgolden replayし、さらに新規frontend/fullstack Source IssueをCISO固有digest/pathなしの標準intakeでgrounded実走 | WF-DF-007 | source→bundle→API→UI→release lineage＋CISO fixture同値 |

## 実装原則

### Contract consumer

- schemaはtagまたはrelease artifactから取得し、commit SHAとdigestをlock metadataへ記録する。
- runtime SDKをimportせず、workflow側のZod projectionはJSON Schemaへconformする。
- remote取得不能でもpinned fixture testは実行できる。

### Planning

- frontend/fullstack要求はdraft段階で止め、承認済みbundleを受けてから最終Issue Contractを作る。
- Designflowはendpointを決めない。Capability Requirementsをworkflowのsystem/API設計へ変換する。
- 全capabilityをIssue/AC/system elementへtraceし、zero coverageを許さない。

### Human gate

- `approve`は同じrequestId、revisionId、bundleDigestだけに有効。
- 未承認、request-changes/reject、ambiguity、digest不一致は`needs-human-review`。
- raw JSONだけを審査UIにせず、目的、effort、attention、全elementの理由、design system/capability deltaを出す。

### Adapter

- 最初はin-memory/file fixture adapterを正規test seamとする。
- 後からCLI/HTTP adapterを追加してもdomain gateとplanningを変更しない。
- live Designflow availabilityをworkflow unit/acceptance testの前提にしない。

## 標準intakeのローカルgrounded完了条件

1. CISO-05の#15 WHAT→Design Request→revision 2 approve→capability reconciliationを
   golden fixtureとして新consumerで同値にreplayする。
2. 新規frontend/fullstack Source Issueを標準GitHub intakeから取り込む。
3. v1 contractに適合するbundleを人間が1回以上request-changesする。
4. 改訂bundleをdigest-boundでapproveし、Capability Requirementsを新規API/system/Issue/ACへtraceする。
5. frontendをapproved Experience Contractへtraceし、Playwright、UX、a11y evidenceを
   同じrevision lineageへ記録してreleaseする。
6. 全経路からCISO固有bundle digest、repository path、#13/#15固定判定を除く。

上記6項目は、固定contract fixture、fake provider／GitHub境界、実headless Chromeを使う決定論E2Eとして
完了した。これはremote serviceや実GitHubへの副作用を伴わないローカル証拠である。

## 実環境で残る完了条件

- remote Designflow providerから同じpublished contractをblack-boxで受ける。
- live GitHubでready claim／label、PR作成、required checks、expected-head merge、
  Source Issue close／release状態を確認する。
- 実targetのfrontend/fullstack変更を同じapproved bundleから生成・releaseする。
- VoiceOver／NVDA、OS high contrast／zoom、物理touch/deviceなど、headless Chromeでは代替できない
  支援技術・device境界を必要な製品matrixで確認する。
- platform release条件に含める場合はApple arm64 container smokeを別途実行する。

## 再開手順

```sh
cd /Users/yu/Company/Development/workflow
git status --short --branch
sed -n '1,260p' docs/handoffs/designflow-integration.md
sed -n '1,260p' docs/decisions/ADR-0012-external-designflow-provider.md
npm test
```

Designflow repositoryをcheckoutしたり起動したりしなくても、WF-DF-001以降を実装できることが
この計画の独立性条件である。
