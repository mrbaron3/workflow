# Designflow consumer実装ハンドオフ

- 更新日: 2026-07-25
- 状態: workflow側の計画確定。実装未着手
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
  ├─ WF-DF-001 contract consumer / fixture
  │      ├─▶ WF-DF-002 provider port / fake adapter
  │      └─▶ WF-DF-003 planning draft split
  ├─ WF-DF-004 digest-bound decision gate
  └─ WF-DF-005 review projection

WF-DF-002 + 003 + 004 ─▶ WF-DF-006 capability reconciliation
WF-DF-005 + 006       ─▶ WF-DF-007 legacy migration
WF-DF-007             ─▶ WF-DF-008 Dashboard grounded run
```

WF-DF-001、WF-DF-004、WF-DF-005は同時着手できる。いずれもDesignflow runtimeを必要としない。

## workflow task

| Key | Issue | 内容 | workflow内の依存 | 完了証拠 |
|---|---|---|---|---|
| WF-DF-001 | [#26](https://github.com/mrbaron3/workflow/issues/26) | contract tag取得、schema validator、fixture pin | なし | valid/invalid fixture test |
| WF-DF-002 | [#27](https://github.com/mrbaron3/workflow/issues/27) | `DesignflowProvider` port＋in-memory/file fake | WF-DF-001 | external processなしのadapter test |
| WF-DF-003 | [#28](https://github.com/mrbaron3/workflow/issues/28) | planning outputをdraft requirementsとfinal Issue Contractへ分離 | WF-DF-001 | backend-only回帰＋UI draft停止 |
| WF-DF-004 | [#29](https://github.com/mrbaron3/workflow/issues/29) | schema/artifact/bundle digest＋Human Decision gate | WF-DF-001 | stale approval／digest mutation拒否 |
| WF-DF-005 | [#30](https://github.com/mrbaron3/workflow/issues/30) | purpose/effort/attention/rationale/capabilityのreview projection | WF-DF-001 | raw JSON不要のsnapshot test |
| WF-DF-006 | [#31](https://github.com/mrbaron3/workflow/issues/31) | Capability→API/system/Issue/AC coverage | WF-DF-002,003,004 | zero/dangling/異revision拒否 |
| WF-DF-007 | [#32](https://github.com/mrbaron3/workflow/issues/32) | legacy `UiDesignArtifact`から明示provider選択へ移行 | WF-DF-005,006 | dual-write／暗黙fallback拒否 |
| WF-DF-008 | [#33](https://github.com/mrbaron3/workflow/issues/33) | #13/#15 Dashboard grounded run | WF-DF-007 | source→bundle→API→UI→release lineage |

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

## Dashboard grounded完了条件

1. #15のWHATをDesign Requestへ変換する。
2. v1 contractに適合するbundleを人間が1回以上request-changesする。
3. 改訂bundleをdigest-boundでapproveする。
4. Capability Requirementsを#13 API／system設計へtraceする。
5. #15 frontendをapproved Experience Contractへtraceする。
6. Playwright、UX、a11y evidenceを同じrevision lineageへ記録してreleaseする。

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
