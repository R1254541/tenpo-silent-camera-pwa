# 店舗仕入れ 無音OCRカメラ PWA

設計書 v2.1 に基づく PWA 主系の v0.1 実装。

## v0.1 実装範囲
- Safari `getUserMedia` の背面カメラ映像を取得
- `<video>` フレームを Canvas に転写して JPEG 生成（シャッター音を発生させない）
- 撮影直後に IndexedDB へ JPEG Blob + metadata を保存
- `capture_id` / `session_id` / `sequence` / `captured_at` / SHA-256 を保持
- 未送信キュー、起動時復旧、オンライン復帰時の再送
- activation URL の fragment (`#endpoint=...&token=...`) を一度だけ読み取り、端末へ保存
- endpoint 設定前でもローカル撮影可能
- Service Worker による PWA shell のオフライン起動

## 重要な制約
- iOS Safari ではネイティブ AVFoundation のような厳密なタップAF/露出制御は保証されない。画面タップのリング表示は撮影補助であり、実際のAF point指定を保証しない。
- Canvas JPEG はカメラ純正の静止画パイプラインと異なるため、OCR品質は iPhone 17 実機で純正Cameraと比較して GO/NO-GO 判定する。
- Safariを閉じている間のBackground Syncを前提にしない。未送信はIndexedDBへ残し、次回起動/オンライン復帰時に再送する。
- Canvas生成JPEGには純正カメラ相当のEXIFを埋め込めないため、`captured_at` を metadata と filename で保持し、必要ならサーバー側release前にEXIFへ反映する。
- HTTPS secure context が必須。

## activation URL 例
`https://camera.example.invalid/#endpoint=https%3A%2F%2Fingress.example.invalid%2Fwebhook%2Ftenpo-camera%2Fv2%2Fcapture&token=ONE_TIME_PROVISIONED_DEVICE_TOKEN`

fragment はHTTPリクエストへ送信されず、読み取り後URLから消去される。

## 次の実機ゲート
1. iPhone 17 / iOS 26 Safariで完全無音確認
2. 代表ラベルを純正Cameraと同条件撮影しOCR比較
3. 30枚連写で欠落0を確認
4. 機内モード中30枚→再起動→復帰後、全件キュー保持を確認
5. Ingress接続後、重複再送してcanonical 1件になることを確認
