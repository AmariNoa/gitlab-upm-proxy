# PROJECT_MAP — gitlab-upm-proxy

Fastify 5 + TypeScript 製の Unity Package Manager 向け GitLab npm レジストリプロキシ。
本ファイルは構造探索の起点となる骨子であり、ファイル一覧の網羅はしない。実態とずれを見つけたらその場で直す。

## ディレクトリ構成

| パス | 役割 |
|------|------|
| src/app.ts | Fastify 起点。サーバーごとの prefetch ライフサイクルを作って起動し、インスタンスへ decorate して onClose で停止させ、AutoLoad で plugins/ と routes/ を読み込む |
| src/routes/gitlab-npm-proxy.ts | PAT 検証フック、search、npm / VPM 中継、tarball 配信、署名適用、全ルート登録（約 1,500 行。最大のファイル） |
| src/lib/cache.ts | metadata.json と tarball のファイルキャッシュ I/O |
| src/lib/upstreams.ts | upstreams 設定ファイル（YAML / JSON）の読込、スコープマッチ、パッケージ名抽出 |
| src/lib/vpm-prefetch.ts | 起動時に VPM インデックスを走査し zip から tgz へ変換・shasum・署名を先行付与。停止シグナルはサーバーごとのライフサイクル（createPrefetchLifecycle / stopVpmPrefetch）で持ち、閉じたサーバーの pass だけが次の項目へ進まず、進行中の臨界区間の完了だけを待つ |
| src/lib/npm-signatures.ts | 署名鍵の生成・読込、tarball 署名、上流 npm の /-/npm/v1/keys 取得とマージ |
| src/lib/tgz.ts | zip から tgz への変換、展開（エントリ数・展開後サイズの上限と展開先の逸脱防止つき）、パッケージ root の判定、一時ディレクトリのロック、sha1 計算 |
| src/lib/env.ts | 必須環境変数の読み出し（未設定なら即座に失敗する mustEnv） |
| src/lib/http.ts | 上流へ送るヘッダの選別（資格情報・応答を狭めるヘッダの除去）と、リダイレクトを上限付きで追従する JSON 取得・バイナリ取得（受信バイト数の上限つき） |
| test/helper.ts | fastify-cli の helper.build で src/app.ts を起動するテストヘルパ |
| test/lib/ | ライブラリ単体テスト（*.test.ts）と test 専用の補助モジュール |
| test/routes/ | ルート統合テスト（*.test.ts）。helper.build でアプリを起動し、上流は MockAgent で差し替える。ログ出力を観測する test/routes/request-log.test.ts だけは、helper.build がロガーを無効化するため Fastify を直接起動する |
| config/upstreams_sample.yml | upstreams 設定のサンプル。実設定 config/upstreams.yml は Git 管理外 |

## 言語・フレームワーク・依存バージョン（package-lock.json の解決済みバージョン）

| パッケージ | バージョン |
|-----------|-----------|
| fastify | 5.7.3 |
| fastify-cli | 7.x（package.json: ^7.4.1） |
| typescript | 5.9.3 |
| undici | 7.18.2 |
| semver | 7.7.3 |
| tar | 7.5.9 |
| yaml | 2.8.2 |
| unzipper | 0.12.3 |
| dotenv | 17.2.3 |

Node.js: README の想定は 20 系（開発機では 24 系でも動作）。

## エントリポイント

- アプリケーション: src/app.ts（fastify-cli が読み込む Fastify プラグイン。package.json の main）
- 開発起動: `npm run dev`（tsc watch と fastify start -P を並行実行）
- 本番起動: `npm start`（`npm run build:ts` の後に `fastify start --options -l info dist/app.js`）
- `--options` は必須。これが無いと fastify-cli は src/app.ts がエクスポートする `options` を読まず、リクエストログのシリアライザ（署名付きクエリの秘匿）が無効になる。README の systemd 例も同じフラグを含む

## ビルド・テスト・lint

| 操作 | コマンド | 状態 |
|------|---------|------|
| ビルド | `npm run build:ts` | tsc で src/ を dist/ へコンパイル |
| 型チェック（テスト含む） | `npx tsc -p test/tsconfig.json` | noEmit。src と test を対象 |
| テスト | `npm test` | 型チェック（test/tsconfig.json）の後に node:test を実行。2026-09-09 時点で 118 ケース（test/routes 8 ファイル、test/lib 5 ファイル）。対象ファイルは package.json の test スクリプトに列挙しており、テストを追加したらここへも追記する。ts-node/register で動かすため tsx は不要 |
| lint / formatter | 設定なし | ESLint・Prettier の設定ファイルは無い |

## テストファイル

- 配置: test/ 配下に src/ の構成をミラーする（test/lib/、test/routes/）。ファイル名は `<対象>.test.ts`
- テストランナー: node:test と node:assert/strict。上流 HTTP は undici の MockAgent でモックし、実ネットワークへ出さない
- テスト専用の補助モジュール（例: test/lib/signing-key-env.ts）は `.test.ts` を付けない

## 設定・環境

### 環境変数

| 変数 | 必須か | 役割 |
|------|--------|------|
| PUBLIC_BASE_URL | 必須 | プロキシの公開 URL（例: https://upm.example.com）。tarball URL の書き換え基点 |
| TARBALL_CACHE_DIR | 必須 | tarball / metadata キャッシュと署名鍵の既定置き場。全モジュールが必須扱いで、未設定なら起動時に `Missing env: TARBALL_CACHE_DIR` で停止する |
| UPSTREAM_CONFIG_PATH | 必須 | upstreams 設定ファイルのパス |
| VPM_PREFETCH_INTERVAL_SEC | 条件付き必須 | VPM prefetch の取得間隔（秒）。VPM 型 upstream があるとき必須だが、読み出しは背景 prefetch の中で行われ、欠けていても起動は止まらず `vpm_prefetch_failed` のログになるだけ |
| NPM_SIGNATURE_KEY_PATH | 任意 | 署名鍵 PEM のパス（既定: TARBALL_CACHE_DIR/npm-signing-key.pem） |
| NPM_SIGNATURE_PRIVATE_KEY_PEM | 任意 | 署名鍵 PEM を直接注入（KEY_PATH より優先） |
| VPM_MAX_DOWNLOAD_BYTES | 任意 | 上流アーカイブ 1 件をメモリへ読み込む上限バイト数（既定: 536870912 = 512 MiB）。Content-Length が上限超過なら本文を読まずに拒否し、実受信量も監視する |
| VPM_MAX_EXTRACT_BYTES | 任意 | zip 展開後の合計バイト数の上限（既定: 1073741824 = 1 GiB）。中央ディレクトリの申告値で事前に拒否し、実書き込み量も監視する |
| VPM_MAX_EXTRACT_ENTRIES | 任意 | zip 内のエントリ数の上限（ファイルとディレクトリの合計。既定: 20000） |
| MAX_UPSTREAM_BODY_BYTES | 任意 | 上流の 1 応答をメモリへ読み込む上限バイト数（既定: 536870912 = 512 MiB）。npm 中継・メタデータ補完に加えて、メタデータ・検索・VPM インデックス・署名鍵の JSON 読み出しにも適用される。VPM の zip 用上限とは別枠 |
| （上記 4 つの上限の検証） | - | src/app.ts が起動時に 1 度読み出すため、正の整数でない値は起動を止める。未設定なら既定値 |

### 設定ファイル

- upstreams 設定: config/upstreams.yml（Git 管理外）。書式は config/upstreams_sample.yml と README を参照
- TypeScript: tsconfig.json（fastify-tsconfig を extends。module NodeNext、outDir dist、sourceMap）。test/tsconfig.json は noEmit で src と test を含む
- 環境変数ファイル: .env（Git 管理外。sample.env が雛形）、test/.env.test（テスト用。DOTENV_CONFIG_PATH で指定）
- Git 管理外（.gitignore）: dist/、node_modules/、coverage/、.env、data/*、config/upstreams.yml、AGENTS.md、CLAUDE.md、docs/orchestration.md、docs/checkpoint.md

### 並行性の前提（単一プロセス）

- キャッシュディレクトリ（TARBALL_CACHE_DIR）を書き換えるのは 1 プロセスだけ、という前提で実装している。metadata の read-modify-write（src/lib/cache.ts の updateMetadataCache）と zip から tgz への変換（src/lib/tgz.ts の runTempLocked）は Promise ベースのロック表で直列化しているが、このロックはプロセス内でしか効かない。
- したがって、同一の TARBALL_CACHE_DIR を複数プロセス（多重起動、複数インスタンス、クラスタ構成）で共有する構成は想定していない。共有が必要になった場合は、ファイルロック等のプロセス間排他を別途導入する必要がある。
- VPM アーカイブの変換・hash・署名・メタデータ公開は、パッケージ単位のロック（`src/lib/tgz.ts` の `runTempLocked`）の下で 1 つの臨界区間として実行する。アーカイブの公開とそれを説明するメタデータの公開は利用者から見て 1 つの変更であり、途中でロックを手放すと新しいアーカイブと古い署名の組み合わせが観測されるため。`serveVpmTarball` のキャッシュヒット時の読み取りも同じロックを取るので、同一パッケージへの同時ダウンロードは直列化され、そのパッケージの変換中は変換完了まで待つ。いずれもローカルファイルの読み取りであり、影響は限定的。
- ただしキャッシュへの公開はいずれも一時ファイルへ書いてから rename する方式で行う。対象は metadata.json（`writeJsonAtomic`）、VPM の zip から変換した tgz（`convertZipBufferToTgz`）、npm 中継の tarball（`writeTarballCache`）の 3 経路で、これがキャッシュへ書き込む経路のすべてである。したがってロックを取らない読み手（別プロセスを含む）が書きかけのファイルを読むことはない。失われうるのは同時更新のうち一方であり、壊れたファイルが残ることではない。

### 既知の制約: tarball URL の名前と版の境界

- VPM 由来 tarball の公開 URL は `/-/<パッケージ名>-<バージョン>.tgz` の形で、名前と版の境界を保持しない。復元は候補を列挙してメタデータキャッシュと照合する方式（`resolveTarballBasename`）だが、境界の異なる 2 つのパッケージが同じファイル名を生成する場合は原理的に区別できない。
- 例: `com.example.pkg` の版 `1.0.0-2.3.4` と、`com.example.pkg-1.0.0` の版 `2.3.4` はどちらも `com.example.pkg-1.0.0-2.3.4.tgz` を広告する。両方が同一 upstream に存在すると、片方の利用者は他方のアーカイブを受け取り integrity 検証に失敗する。
- 検出時は `tarball_name_collision` のログを出すが、URL 形式を変えない限り解消できない。回避するには、パッケージ名の末尾を semver と解釈できる形（`-1.2.3` 等）にしないこと。

## ドキュメント

- README.md: 概要、対応エンドポイント、設定、VPM の挙動、認証、Ubuntu Server へのインストール・更新手順
- docs/orchestration.md、docs/checkpoint.md: エージェント運用の共有コーディネーションファイル（Git 管理外）
