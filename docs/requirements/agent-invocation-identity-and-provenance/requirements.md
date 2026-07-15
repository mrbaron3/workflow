# Agent invocation identity and provenance 受け入れ要件

## 意図

- 機能: Agent invocation identity and provenance
- outcome: 全 role session が role・perspective・provider・model・prompt・outcome を共通の invocation identityで
  耐久記録し、どのエージェントが何を生成・採点したかをmetricsと監査から正しく辿れる。
- 計画の木リンク: feature=FEAT-013 epic=EPIC-07

## 受け入れ基準

- **[AC-AGINV-001] 同じlogical callは安定したInvocation Identityを持つ**
  - Given subject/sample/attempt/role/perspectiveが同じ呼出し座標である
  - When identityを複数回生成する
  - Then 同じkeyになり、いずれかの座標が異なる呼出しとは衝突しない

- **[AC-AGINV-002] generator sessionの実provenanceを1件記録する**
  - Given generatorが実sessionを完了またはstuck/timeoutで返す
  - When executionが結果をstoreへ投影する
  - Then role=generator、実provider、nullable model、完全なprompt、実outcomeが同一identityへ耐久保存される

- **[AC-AGINV-003] reviewerをPerspectiveごとの独立invocationとして記録する**
  - Given 複数Perspective reviewerを並行実行する
  - When session結果をstoreへ投影する
  - Then Perspectiveごとに異なるInvocation Identityとprompt/outcomeが記録され、generator recordへ混在しない

- **[AC-AGINV-004] 再記録は冪等でprovenance conflictを拒否する**
  - Given あるInvocation Identityが記録済みである
  - When 同一provenanceを再記録する、またはprovider/model/promptの異なる値で再記録する
  - Then 前者はrecord/counterを増やさず同じrecordを返し、後者は既存recordを変えず理由付きで拒否する

- **[AC-AGINV-005] legacy PromptRecordを壊さずadditive migrationする**
  - Given agentInvocationsを持たない既存DBとPromptRecord履歴がある
  - When 新schemaで読込み新しいinvocationを記録する
  - Then legacy履歴は保持され、agentInvocationsは空から開始し、以後dual-writeなしで独立保存される

- **[AC-AGINV-006] reviewer EvalRunとmetricsは実providerへtraceできる**
  - Given reviewer invocationからPerspective verdictを採点する
  - When EvalRunを保存しmetricsを計算する
  - Then EvalRun.invocationKeyから同Perspective invocationを逆引きでき、provider別invocation件数はgeneratorの
    agent値で代用せずAgentInvocation.providerから集計される

## レッドライン

- providerとmodelを1つの文字列へ潰さない。
- reviewer providerをPR.generatorまたはconfig.generatorから推測しない。
- 同じlogical invocationをresumeごとに重複appendしない。
- identity conflictをlast-write-winsで上書きしない。
- legacy PromptRecordを削除・暗黙変換・dual-writeしない。
- deterministic graderをAI invocationとして捏造しない。
