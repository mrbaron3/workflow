# ユビキタス言語 — intake コンテキスト

> intakeは外部の人間WHAT投影をstore内のplanning在庫へ安全に取り込む境界。Issue Contractの著述、
> execution queue、GitHub PR gateは所有しない。追加のみ。

| ID | 用語 | 意味 |
| --- | --- | --- |
| LANG-intake-001 | Source Issue | target repositoryで人間が作成したGitHub Issue。storeの真実ではなくWHATの外部投影。 |
| LANG-intake-002 | Ready Signal | watcherが取り込んでよいことを人間が明示したlabel。既定`ready`、configで変更可能。 |
| LANG-intake-003 | Intake Identity | `(provider, repository, issue number)`で一意な外部source identity。title/bodyをidentityに使わない。 |
| LANG-intake-004 | Source Snapshot | 初回発見時のtitle/body/labels/url/source updatedAt。planningの根拠としてimmutableに保持する原文。 |
| LANG-intake-005 | Claim | Source IssueをこのOrganization Storeのplanning対象として一度だけ確保する状態遷移。 |
| LANG-intake-006 | Claim Pending | storeへidentity/snapshotを先に耐久化したが、外部claim label反映が未完了の再試行可能状態。 |
| LANG-intake-007 | Intake Watcher | ready Source Issueをpollし、stable orderでclaimする決定論コード。planning agentではない。 |
| LANG-intake-008 | Enrichment Candidate | planning-agentが1つのSource Snapshotから提案する1..N個のschema-valid Issue Contract候補。 |
| LANG-intake-009 | Acceptance Trace | Candidateの各ACをSource Snapshot内の実在text、または実在system element idへ結ぶ根拠edge。 |
| LANG-intake-010 | Planning Ambiguity | 原文/systemだけでは一意に決められず、人間WHAT判断が必要な未解決点。推測してcontractへ変換しない。 |
| LANG-intake-011 | UI Design Readiness | frontend/fullstack Candidateをgeneric実装へ投影する前に、専用UI著述がschema-valid・trace-complete・provenance-completeなUI Design Artifactを供給した状態。不在・曖昧・不正は明示的な停止理由。 |
| LANG-intake-012 | UI Design Artifact | 1 Enrichment CandidateのACをdesign principles、tokens、components、states/interactions、accessibilityへ写し、各設計要素をACへ逆参照できるHOW契約。 |
| LANG-intake-013 | Designflow Provider | Design Requestからrevisioned Design Bundleを作る外部Open Host Service。workflow内部型、store、agent promptを共有しない。 |
| LANG-intake-014 | Design Request | Source Snapshot、product intent、要求trace、制約、surface、design system base revisionをproviderへ渡すversioned Published Language。最終Issue/API形は含めない。 |
| LANG-intake-015 | Design Bundle | Experience Contract、Design System Delta、Capability Requirements、previewをmanifestで束ねたcontent-addressed成果物。 |
| LANG-intake-016 | Experience Contract | page purpose、task、flow、effort budget、attention hierarchyと、全elementのplacement rationale/removal impactを表す体験設計契約。 |
| LANG-intake-017 | Capability Requirement | UI/UXが必要とするquery/command、認可、freshness、idempotency、failure semantics等の能力要求。endpointや実装方式はplanning/designが決める。 |
| LANG-intake-018 | Human Design Decision | 人間が特定`revisionId`＋`bundleDigest`へ与えるapprove/request-changes/reject。artifact変更後へ持ち越せない。 |
| LANG-intake-019 | Planning Human Review Outcome | planning gateの未解決点をSource Issueへ戻し、人間のWHAT判断までretryせず終端する正常系outcome。provider failureやHOW介入ではない。 |
