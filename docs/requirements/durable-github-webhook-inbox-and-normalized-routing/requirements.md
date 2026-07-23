# Durable GitHub webhook inbox and normalized routing 受け入れ要件

## 意図

- 機能: Durable GitHub webhook inbox and normalized routing
- outcome: GitHub deliveryを成功応答前に耐久保存し、delivery IDで重複排除し、登録repoの許可eventだけを
  transport非依存eventとしてconsumerへ渡せる。
- 計画の木リンク: feature=FEAT-025 epic=EPIC-12

## 受け入れ基準

- **[AC-WHIN-001] 検証済みdeliveryをACK前に耐久保存する**
  - Given有効なevent、repository、JSON payload、delivery ID
  - Wheningressが受信する
  - ThenEnvelopeをstoreへ保存した後だけaccepted receiptを返し、保存失敗は成功扱いしない

- **[AC-WHIN-002] 同じdelivery IDの再送は1 record・1 consumer効果になる**
  - Given既に保存済みのdelivery ID
  - When同じdeliveryを再受信する
  - Then既存receiptをduplicateとして返し、新recordも新routingも作らない

- **[AC-WHIN-003] 未登録repoと未許可eventは理由付きignoredになる**
  - Givenregistrationが無いrepo、またはeventsに含まれないevent
  - Whendeliveryを保存・routeする
  - Thenrecordをignoredに更新し、理由を残し、consumerを起動しない

- **[AC-WHIN-004] 登録repoのeventをNormalized GitHub Eventへ変換する**
  - Givenenabled registrationと許可event
  - Whenrouterを実行する
  - Thenrepository/event/action/deliveryKey/payloadをPublished Languageへ変換し、列挙consumerだけへ渡す

- **[AC-WHIN-005] consumer失敗を再実行可能なfailed recordとして残す**
  - Givenconsumerが例外またはfailureを返す
  - Whenrouterを実行する
  - ThenattemptとlastErrorを保存してfailedにし、payloadを失わず明示retryでpendingへ戻せる

- **[AC-WHIN-006] store更新はatomicで既存Eval DBと競合しない**
  - Givendaemonと通常harness CLIが同じrootを使う
  - Whenregistration/deliveryを書き込む
  - Then専用`.harness/webhooks.json`をtemp＋renameで保存し、`.harness/db.json`へ書かない

## レッドライン

- payloadだけからclaim、merge、releaseを確定しない。
- 保存前に2xxを返さない。
- delivery ID重複でconsumerを再実行しない。
- GUI/registrationから任意shell commandを実行しない。
- Webhookが届くことを前提にpoll reconciliationを削除しない。
