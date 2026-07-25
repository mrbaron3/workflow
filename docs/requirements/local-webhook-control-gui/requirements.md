# Local webhook control GUI 受け入れ要件

## 意図

- 機能: Local webhook control GUI
- outcome: loopback GUIから複数repositoryの追加・有効化、events/consumer設定、delivery状態を管理できる。
- 計画の木リンク: feature=FEAT-027 epic=EPIC-12

## 受け入れ基準

- **[AC-WHUI-001] 登録repo一覧と状態を1画面で確認できる**
  - Given0件以上のRepository Registration
  - WhenGUIを開く
  - Thenrepository、enabled、events、consumers、workspace、更新時刻を表示する

- **[AC-WHUI-002] owner/nameを検証してrepositoryを追加できる**
  - Given有効な`owner/name`、1件以上のeventとconsumer
  - When追加フォームを送信する
  - Thenregistrationを耐久保存し一覧へ反映する

- **[AC-WHUI-003] 重複・不正repo・未知consumerを拒否する**
  - Given既存repository、不正なrepository文字列、列挙外consumer
  - WhenAPIへ登録する
  - Then4xxと理由を返しstoreを変更しない

- **[AC-WHUI-004] delivery履歴と失敗理由を確認・retryできる**
  - Givenprocessed/ignored/failed delivery
  - WhenGUIを開きfailedをretryする
  - Then状態・attempt・lastErrorを表示し、retry対象だけをpendingへ戻す

- **[AC-WHUI-005] loopback以外へ既定公開しない**
  - Given既定設定
  - Whencontrol serverを起動する
  - Then`127.0.0.1`へbindし、mutation APIはsame-origin JSON requestだけを受ける

- **[AC-WHUI-006] UIから任意commandを設定・実行できない**
  - Givenrepository登録・編集画面
  - When操作可能項目を検査する
  - Thenconsumerは列挙選択だけでcommand/path shell入力面が存在しない

## レッドライン

- GitHub token、Webhook secret、raw認証headerをHTMLへ出さない。
- repo削除でdelivery監査履歴を消さない（初期版はenabled切替のみ）。
- CDNやremote hostingを必須にしない。
