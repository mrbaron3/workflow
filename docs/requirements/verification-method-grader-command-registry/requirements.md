# Verification-method grader command registry 受け入れ要件

## 意図

- 機能: Verification-method grader command registry
- outcome: unit_test以外のAcceptance Criterionも宣言したverification methodそのものの実commandで採点し、
  未設定を暗黙passにせず、同じ実行手段を回帰へ持ち越せる。
- 計画の木リンク: feature=FEAT-019 epic=EPIC-09

## 受け入れ基準

- **[AC-GRDCMD-001] method-keyed registryが正規のgrader設定になる**
  - Giventargetに`graders.commands[method]`と既存`typecheck`/`unit_tests` aliasがある
  - Whenverification methodのcommandを解決する
  - Then正規registryを優先し、legacy aliasは同一methodだけへ互換解決され、別methodへfallbackしない

- **[AC-GRDCMD-002] 非unit commandはAcceptance Criterion単位で隔離実行される**
  - Given同じplaywright methodを持つ複数ACがある
  - Whengrounded buildを採点する
  - Then各commandへAC ID、Issue ID、method、expectedを環境で個別に渡し、兄弟ACの結果を共有しない

- **[AC-GRDCMD-003] command未設定・失敗はfail-closedになる**
  - Given自動採点methodを宣言したACに対応commandがない、またはcommandが非zeroで終了する
  - Whengrounded artifactを作る
  - ThenそのACはunsatisfiedとなり、blockerならpanel前にrequest_changesとなり、suite green等で補完しない

- **[AC-GRDCMD-004] criterionごとのgrounded evidenceをartifactへ残す**
  - Givenintrinsic check、成功command、失敗command、未設定commandのいずれかでACを評価する
  - Whenartifactを監査する
  - ThenAC IDからmethod、実commandまたはnull、pass/fail、境界化されたoutputを辿れる

- **[AC-GRDCMD-005] Curatorがmethod固有commandをtargetと共にcaptureする**
  - Givenblocker ACがplaywright等の非unit methodを宣言し、target registryにcommandがある
  - WhenEval Taskへcurateまたはlegacy taskをbackfillする
  - Then`graderCommands[method]`へその時点のcommandを保存し、別target・別method・設定無しを捏造しない

- **[AC-GRDCMD-006] Regressionがcaptured commandを同じcriterion identityで再実行する**
  - Given非unit methodとcaptured commandを持つEval Taskがある
  - Whenregression executorを実行する
  - Thenbound targetでAC identityを渡してcommandを再実行し、exit結果をRegressionRunへpass/failとして耐久記録する

## レッドライン

- playwright/API等をunit_testの結果で代用しない。
- command未設定をpassにしない。
- shellを介してcommand injection可能な実行へ戻さない。
- 1つのACの成功を同methodの全ACへ複製しない。
- current configで過去Eval Taskのcaptured commandを上書きしない。
