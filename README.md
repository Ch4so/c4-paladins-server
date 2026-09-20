# C4 Paladins Draft Trainer — オンラインサーバー 公開ガイド

このフォルダ（`server/`）だけを無料ホストに公開すれば、インターネット越しの対戦（Windows / iOS / Android / Web すべてクロスプレイ）が有効になります。

含まれるファイル: `server.js` / `package.json` / `render.yaml` / `.gitignore`

---

## 方法A（推奨・ブラウザだけで完結）: GitHub + Render

### 1. GitHub にコードを置く
1. https://github.com でアカウント作成 → ログイン
2. 右上「+」→ **New repository** → 名前 `c4-paladins-server` → **Create**
3. リポジトリ画面の **「uploading an existing file」** をクリック
4. この `server` フォルダの中身（`server.js`, `package.json`, `render.yaml`, `.gitignore`）を**ドラッグ&ドロップ** → **Commit changes**

### 2. Render で公開
1. https://render.com でアカウント作成（GitHubでログインが簡単）
2. **New +** → **Web Service** → 手順1のリポジトリを接続
3. 設定（自動検出されるはず）:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
4. **Create Web Service** → 数分でデプロイ完了
5. 発行された URL（例: `https://c4-paladins-server.onrender.com`）をコピー

### 3. アプリ側に設定
- アプリの「オンライン対戦」ロビーの **サーバーURL** 欄に、上記URLを貼る（対戦する全員が同じURLを入れる）
- 以上で世界中どこの誰とでも、どの端末同士でも対戦可能！

> 注意（無料枠）: Render の無料プランは一定時間アクセスが無いとスリープし、次の接続時に復帰まで30秒〜1分ほどかかることがあります（対戦品質には影響しません）。

---

## 方法B（さらに手軽）: Glitch / Replit
- **Glitch** (https://glitch.com) や **Replit** (https://replit.com) は、ブラウザ上で新規プロジェクトを作り `server.js` と `package.json` を貼り付けて実行するだけで公開URLが得られます（GitHub不要）。WebSocket対応。無料枠はスリープあり。

---

## 方法C（アカウント不要・一時的・今すぐ試す）: Cloudflare Tunnel
自分のPCでサーバーを動かしたまま、一時的な公開URLを作る方法です（PCを起動している間だけ有効）。
```
# 1) このフォルダで依存を入れて起動
npm install
npm start           # → localhost:3000 で起動
# 2) 別ウィンドウで cloudflared を入れて実行（アカウント不要のクイックトンネル）
cloudflared tunnel --url http://localhost:3000
# → https://xxxx.trycloudflare.com の一時URLが表示される。これを全員のロビーに入れる
```

---

## ローカル/LANでのテスト
同じPCや同じWi-Fi内なら、`npm start` で起動し、ロビーのURLに `http://<起動PCのローカルIP>:3000`（同一PCなら `http://localhost:3000`）を入れれば対戦できます。
