# PROJECT_MAP — gitlab-upm-proxy

Fastify 5 + TypeScript 製の Unity Package Manager 向け GitLab npm レジストリプロキシ。
本ファイルは構造探索の起点となる骨子であり、ファイル一覧の網羅はしない。実態とずれを見つけたらその場で直す。

## ディレクトリ構成

| パス | 役割 |
|------|------|
| src/app.ts | Fastify 起点。VPM prefetch を起動し、AutoLoad で plugins/ と routes/ を読み込む |
| src/routes/gitlab-npm-proxy.ts | PAT 検証フック、search、npm / VPM 中継、tarball 配信、署名適用、全ルート登録（約 1,500 行。最大のファイル） |
| src/lib/cache.ts | metadata.json と tarball のファイルキャッシュ I/O |
| src/lib/upstreams.ts | upstreams 設定ファイル（YAML / JSON）の読込、スコープマッチ、パッケージ名抽出 |
| src/lib/vpm-prefetch.ts | 起動時に VPM インデックスを走査し zip から tgz へ変換・shasum・署名を先行付与 |
| src/lib/npm-signatures.ts | 署名鍵の生成・読込、tarball 署名、上流 npm の /-/npm/v1/keys 取得とマージ |
| src/lib/tgz.ts | zip から tgz への変換、展開、パッケージ root の判定、一時ディレクトリのロック、sha1 計算 |
| src/lib/env.ts | 必須環境変数の読み出し（未設定なら即座に失敗する mustEnv） |
| test/helper.ts | fastify-cli の helper.build で src/app.ts を起動するテストヘルパ |
| test/lib/ | ライブラリ単体テスト（*.test.ts）と test 専用の補助モジュール |
| test/routes/ | ルート統合テスト（*.test.ts）。helper.build でアプリを起動し、上流は MockAgent で差し替える |
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
- 本番起動: `npm start`（`npm run build:ts` の後に `fastify start -l info dist/app.js`）

## ビルド・テスト・lint

| 操作 | コマンド | 状態 |
|------|---------|------|
| ビルド | `npm run build:ts` | tsc で src/ を dist/ へコンパイル |
| 型チェック（テスト含む） | `npx tsc -p test/tsconfig.json` | noEmit。src と test を対象 |
| テスト | `npm test` | 型チェック（test/tsconfig.json）の後に node:test を実行。2026-09-07 時点で 28 ケース（test/routes 13、test/lib 15）。ts-node/register で動かすため tsx は不要 |
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
| VPM_PREFETCH_INTERVAL_SEC | 条件付き必須 | VPM prefetch の取得間隔（秒）。VPM 型 upstream があるとき必須 |
| NPM_SIGNATURE_KEY_PATH | 任意 | 署名鍵 PEM のパス（既定: TARBALL_CACHE_DIR/npm-signing-key.pem） |
| NPM_SIGNATURE_PRIVATE_KEY_PEM | 任意 | 署名鍵 PEM を直接注入（KEY_PATH より優先） |

### 設定ファイル

- upstreams 設定: config/upstreams.yml（Git 管理外）。書式は config/upstreams_sample.yml と README を参照
- TypeScript: tsconfig.json（fastify-tsconfig を extends。module NodeNext、outDir dist、sourceMap）。test/tsconfig.json は noEmit で src と test を含む
- 環境変数ファイル: .env（Git 管理外。sample.env が雛形）、test/.env.test（テスト用。DOTENV_CONFIG_PATH で指定）
- Git 管理外（.gitignore）: dist/、node_modules/、coverage/、.env、data/*、config/upstreams.yml、AGENTS.md、CLAUDE.md、docs/orchestration.md、docs/checkpoint.md

### 並行性の前提（単一プロセス）

- キャッシュディレクトリ（TARBALL_CACHE_DIR）を書き換えるのは 1 プロセスだけ、という前提で実装している。metadata の read-modify-write（src/lib/cache.ts の updateMetadataCache）と zip から tgz への変換（src/lib/tgz.ts の runTempLocked）は Promise ベースのロック表で直列化しているが、このロックはプロセス内でしか効かない。
- したがって、同一の TARBALL_CACHE_DIR を複数プロセス（多重起動、複数インスタンス、クラスタ構成）で共有する構成は想定していない。共有が必要になった場合は、ファイルロック等のプロセス間排他を別途導入する必要がある。
- ただしキャッシュへの公開はいずれも一時ファイルへ書いてから rename する方式で行う。対象は metadata.json（`writeJsonAtomic`）、VPM の zip から変換した tgz（`convertZipBufferToTgz`）、npm 中継の tarball（`writeTarballCache`）の 3 経路で、これがキャッシュへ書き込む経路のすべてである。したがってロックを取らない読み手（別プロセスを含む）が書きかけのファイルを読むことはない。失われうるのは同時更新のうち一方であり、壊れたファイルが残ることではない。

## ドキュメント

- README.md: 概要、対応エンドポイント、設定、VPM の挙動、認証、Ubuntu Server へのインストール・更新手順
- docs/orchestration.md、docs/checkpoint.md: エージェント運用の共有コーディネーションファイル（Git 管理外）
