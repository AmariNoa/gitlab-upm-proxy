# 実機確認手順書（manual verification）

自動テストで確認できない範囲を、実際のサーバーと実際のレジストリに対して人手で確認するための手順書。

## 目的と前提

- 対象: gitlab-upm-proxy の npm ECDSA 署名機能（VPM 由来 tarball の署名、`/-/npm/v1/keys` の公開、署名のキャッシュ永続化と再利用）と、既存の中継・認証・キャッシュの基本動作。
- 実施環境: **検証系のサーバーで実施する**。本番系では実施しない（キャッシュディレクトリの内容を確認・削除する手順を含むため）。
- 自動テストで確認済みの範囲: `npm test`（2026-09-09 時点で 140 ケース）は上流を undici の MockAgent でモックし、単一プロセス内でルート中継、PAT 認証、署名の生成、`/-/npm/v1/keys` の集約（重複排除・自鍵の優先・keyid 不一致の鍵の除外）、署名のキャッシュ永続化と再利用、zip から tgz への変換、キャッシュの並行制御に加えて、URL のデコード境界とスコープ付き名前、上流失敗の分類（404 / 502 / 500）、応答ヘッダの選別、アーカイブとダウンロードの上限、prefetch の停止と所有権、撤回削除の排他を確認している。署名の検証も node:crypto による同一プロセス内での照合にとどまる。
- 自動テストに含まれない範囲: 実サーバーの起動、実 GitLab / 実 VPM レジストリとの通信、実クライアント（npm CLI の `npm audit signatures`、Unity Package Manager）による署名検証と取得、複数プロセスで同一キャッシュディレクトリを共有する構成での動作。本手順書はこの差分を埋めるためのもの。
- 実施者: 人間。エージェントは本手順書の記述までを担当し、実機での実行と結果の判定は行わない。
- 表記: 実環境の値はすべてプレースホルダで書いている。実施時に自分の環境の値へ読み替える。

| プレースホルダ | 意味 |
|---|---|
| `/opt/gitlab-upm-proxy` | プロキシの配置ディレクトリ |
| `/var/lib/gitlab-upm-proxy/cache` | `TARBALL_CACHE_DIR` の実体 |
| `https://upm.example.com` | プロキシの公開 URL（`PUBLIC_BASE_URL`） |
| `https://gitlab.example.com` | 既定 GitLab の URL（`config/upstreams.yml` の `default`） |
| `https://vpm.example.com/index.json` | VPM 型 upstream の index URL |
| `my-group` | GitLab のグループパス（URL エンコード前） |
| `com.example.vpm.pkg` | 検証に使う VPM 由来パッケージ名 |
| `1.0.0` | 検証に使うバージョン |
| `123` | GitLab のプロジェクト ID |

## 事前準備

### P-1 認証情報の用意

GitLab の Personal Access Token（`read_api` と `read_package_registry` を含むスコープ）を用意し、実施するシェルの環境変数へ入れる。**トークンをコマンドライン引数へ直接書かない。手順書・ログ・チャットへ値を貼らない。**

```bash
read -rs GITLAB_PAT && export GITLAB_PAT
```

シェル履歴に残さないため `read -rs` を使う。作業終了後は `unset GITLAB_PAT` する。

### P-2 ビルドと配置

```bash
cd /opt/gitlab-upm-proxy
git status --short
npm run build:ts
```

`git status --short` で作業ツリーがクリーンであること（検証したいコミットの状態であること）を先に確認する。

### P-3 設定

`config/upstreams.yml` に、既定 GitLab と、検証に使う VPM 型 upstream が設定されていることを確認する。

```bash
grep -nE '^(default|upstreams):|baseUrl|type|scopes' /opt/gitlab-upm-proxy/config/upstreams.yml
```

環境変数（systemd の場合は `/etc/systemd/system/gitlab-upm-proxy.service` の `Environment=` 行）に次が設定されていることを確認する。

| 変数 | 必須 | 備考 |
|---|---|---|
| `PUBLIC_BASE_URL` | 必須 | tarball URL の書き換え基点 |
| `TARBALL_CACHE_DIR` | 必須 | キャッシュと署名鍵の置き場 |
| `UPSTREAM_CONFIG_PATH` | 必須 | upstreams 設定のパス |
| `VPM_PREFETCH_INTERVAL_SEC` | VPM 型 upstream があるとき必須 | prefetch の取得間隔（秒） |
| `NPM_SIGNATURE_KEY_PATH` | 任意（推奨） | 署名鍵を固定するパス。未設定だと `TARBALL_CACHE_DIR/npm-signing-key.pem` に自動生成される |
| `VPM_MAX_DOWNLOAD_BYTES` | 任意 | VPM アーカイブ 1 件をメモリへ読み込む上限（既定 536870912 = 512 MiB） |
| `VPM_MAX_EXTRACT_BYTES` | 任意 | zip 展開後の合計サイズの上限（既定 1073741824 = 1 GiB） |
| `VPM_MAX_EXTRACT_ENTRIES` | 任意 | zip 内のエントリ数（ファイルとディレクトリの合計）の上限（既定 20000） |
| `MAX_UPSTREAM_BODY_BYTES` | 任意 | 上流の 1 応答をメモリへ読み込む上限（既定 536870912 = 512 MiB）。npm 中継・メタデータ補完・JSON 読み出しに適用 |

上限 4 つはいずれも任意で、未設定なら既定値が使われる。設定する場合は正の整数であること。正の整数でない値を設定すると**起動時に**失敗するので、起動できていれば値は解釈されている。

```bash
sudo systemctl cat gitlab-upm-proxy | grep -n '^Environment='
```

### P-4 署名鍵の固定（推奨）

署名鍵はデプロイをまたいで同一である必要がある（鍵が変わるとクライアント側の検証が失敗する）。`NPM_SIGNATURE_KEY_PATH` を設定し、その PEM ファイルをバックアップ対象に含める。

```bash
sudo ls -l /var/lib/gitlab-upm-proxy/cache/npm-signing-key.pem
```

ファイルの権限が所有者のみ（600）であることを確認する。**中身は表示しない。**

---

## M-1 サーバーの起動

**前提条件**: P-2 と P-3 が完了していること。

**操作手順**

```bash
sudo systemctl restart gitlab-upm-proxy
sudo systemctl status gitlab-upm-proxy --no-pager
sudo journalctl -u gitlab-upm-proxy -n 50 --no-pager
```

**期待される結果**

- `systemctl status` が `active (running)` を示す。
- `ExecStart` に `--options` が含まれている。これが無いと fastify-cli は `src/app.ts` がエクスポートするサーバーオプションを読まず、リクエストログのシリアライザが無効になる。**起動もリクエスト処理も成功するため、欠けていても症状は M-8 のログ確認でしか現れない。**
  ```bash
  sudo systemctl cat gitlab-upm-proxy | grep -n ExecStart
  ```
- 起動ログに例外・スタックトレースが出ていない。
- `PUBLIC_BASE_URL`・`TARBALL_CACHE_DIR`・`UPSTREAM_CONFIG_PATH` のいずれかが欠けている場合は、モジュール読み込みの時点で `Missing env: <変数名>` のエラーとなり、プロセスが起動しない（設定漏れが黙って無視されない）。
- `VPM_PREFETCH_INTERVAL_SEC` はこれらと扱いが異なる。読み出しが背景の prefetch の中で行われ、そこでの例外は捕捉されて `vpm_prefetch_failed` のログになるだけなので、**欠けていてもサーバーは起動して動き続ける**。VPM 型 upstream を設定しているのにこのログが出ている場合は、prefetch が一度も動いていないことを意味するため、設定を確認する。
- VPM 型 upstream を設定している場合、upstream ごとに `vpm_prefetch_start` と `vpm_prefetch_complete` が出て、その間にバージョンごとの `vpm_prefetch_done`（取得・変換・署名まで完了）または `vpm_prefetch_skip`（当該バージョンを飛ばした）が出る（起動時の prefetch が動いている）。
- サーバーを停止すると prefetch も停止する。`systemctl stop` の後に `vpm_prefetch_done` が続かないことを確認する（停止はサーバー単位で、進行中の変換の完了だけを待つ）。

---

## M-2 PAT 認証

**前提条件**: M-1 が成功していること。P-1 で `GITLAB_PAT` を設定していること。

**操作手順**

```bash
# (1) ヘッダ無し
curl -s -o /dev/null -w '%{http_code}\n' "https://upm.example.com/api/v4/groups/my-group/-/v1/search?text=example&from=0&size=10"

# (2) 無効なトークン
curl -s -H 'PRIVATE-TOKEN: invalid-token-for-testing' "https://upm.example.com/api/v4/groups/my-group/-/v1/search?text=example&from=0&size=10"

# (3) 有効なトークン
curl -s -o /dev/null -w '%{http_code}\n' -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/-/v1/search?text=example&from=0&size=10"
```

**期待される結果**

| 手順 | HTTP | レスポンスボディ |
|---|---|---|
| (1) | 401 | `{"error":"missing_token"}` |
| (2) | 401 | `{"error":"invalid_token"}` |
| (3) | 200 | 検索結果の JSON |

既定 GitLab へ到達できない場合、(2)(3) は 401 `{"error":"token_check_failed"}` になる。この場合はネットワーク・`config/upstreams.yml` の `default` を確認してから再実行する。

---

## M-3 検索とメタデータ取得

**前提条件**: M-2 の (3) が 200 であること。

**操作手順**

```bash
# 検索
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/-/v1/search?text=com.example&from=0&size=10" | head -c 2000

# メタデータ取得（GitLab 由来のパッケージ名で実行する）
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/com.example.somepkg" | head -c 2000
```

**期待される結果**

- 検索は `objects` 配列と `total` を含む JSON を返す（npm search v1 互換の形）。
- 検索は GitLab の Packages API と設定済みの全 upstream を引いて結果を統合し、その upstream がスコープ上担当しない名前は落とす。したがって `objects` には複数のレジストリ由来の結果が混ざりうる。**GitLab の列挙が失敗すると検索全体が失敗する**（他のレジストリに一致があっても同じ）ので、検索が失敗した場合はまず GitLab 側の応答を確認する。
- メタデータは `name`、`dist-tags`、`versions` を含む JSON を返す。
- `versions.<version>.dist.tarball` が `https://upm.example.com/` で始まる URL に書き換わっている（クライアントがプロキシ経由で取得できる形になっている）。

---

## M-4 VPM 署名の付与・永続化・再利用

本機能の中心。**キャッシュを一度空にしてから実施する**（前回の残骸による誤判定を避けるため）。

**前提条件**: `config/upstreams.yml` に `type: vpm` の upstream があり、`com.example.vpm.pkg` がそのスコープに一致すること。

**操作手順**

```bash
# (1) 対象パッケージのキャッシュだけを削除する（cache 全体を消さない）
sudo systemctl stop gitlab-upm-proxy
sudo ls -la /var/lib/gitlab-upm-proxy/cache/vpm.example.com/
sudo rm -rf /var/lib/gitlab-upm-proxy/cache/vpm.example.com/com.example.vpm.pkg
sudo systemctl start gitlab-upm-proxy

# (2) prefetch の完了を待つ
# 起動時の prefetch は待たれずに走り、tgz を取得し終えていないバージョンは応答から除外される。
# キャッシュを消した直後に取得すると、正常なサーバーでも versions['1.0.0'] が存在せず、
# 以降の手順が誤って失敗する。最大 120 秒だけ待ち、出てこなければ prefetch 側の問題として
# 切り分ける（journalctl の vpm_prefetch_failed / vpm_prefetch_skip を確認する）。
for i in $(seq 1 60); do
  curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/com.example.vpm.pkg" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get('versions',{}).get('1.0.0',{}).get('dist',{}).get('integrity') else 1)" && break
  sleep 2
done

# (3) 1 回目の取得
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/com.example.vpm.pkg" > /tmp/vpm-meta-1.json
python3 -c "import json;d=json.load(open('/tmp/vpm-meta-1.json'));v=d['versions']['1.0.0']['dist'];print(v.get('integrity'));print(json.dumps(v.get('signatures')))"

# (4) ディスク上のキャッシュを確認
sudo python3 -c "import json;d=json.load(open('/var/lib/gitlab-upm-proxy/cache/vpm.example.com/com.example.vpm.pkg/metadata.json'));v=d['metadata']['versions']['1.0.0']['dist'];print(v.get('integrity'));print(json.dumps(v.get('signatures')))"

# (5) 2 回目の取得（署名が再計算されないことの確認）
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/com.example.vpm.pkg" > /tmp/vpm-meta-2.json
diff <(python3 -c "import json;print(json.dumps(json.load(open('/tmp/vpm-meta-1.json'))['versions']['1.0.0']['dist'],sort_keys=True))") <(python3 -c "import json;print(json.dumps(json.load(open('/tmp/vpm-meta-2.json'))['versions']['1.0.0']['dist'],sort_keys=True))") && echo "IDENTICAL"

# (6) tarball の取得と integrity の突き合わせ
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" -o /tmp/vpm-pkg.tgz "https://upm.example.com/-/com.example.vpm.pkg-1.0.0.tgz"
echo "sha512-$(openssl dgst -sha512 -binary /tmp/vpm-pkg.tgz | base64 -w0)"
```

**期待される結果**

- (2) のループが 120 秒以内に抜ける。抜けない場合は prefetch が完了していないか失敗しているので、`journalctl -u gitlab-upm-proxy -n 200 --no-pager | grep vpm_prefetch` を確認し、**署名機能の失敗と混同しない**。
- (3) `dist.integrity` が `sha512-` で始まる文字列、`dist.signatures` が `[{"keyid":"SHA256:...","sig":"..."}]` の形で返る。
- (4) ディスクの `metadata.json` にも (3) と同じ `integrity` と `signatures` が保存されている（署名が永続化されている）。
- (5) `diff` が差分なしで `IDENTICAL` を表示する（2 回目に署名が作り直されていない）。
- (6) 計算した `sha512-...` が (3) の `dist.integrity` と一致する（署名対象が実際に配信される tarball と同一）。
- 一連の操作で 500 系のエラーが出ない。

**判定の注意**: (5) は「値が同じ」ことしか示さない。再計算そのものが行われていないかを厳密に見るなら、(5) の実行前後で CPU 時間やレスポンス時間の差、あるいは `journalctl` のログ量を併せて観察する。

---

## M-5 署名鍵エンドポイント

**前提条件**: M-1 が成功していること。

**操作手順**

```bash
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/-/npm/v1/keys"
curl -s -H "PRIVATE-TOKEN: $GITLAB_PAT" "https://upm.example.com/api/v4/groups/my-group/-/npm/v1/keys"
```

**期待される結果**

- どちらも `{"keys":[...]}` の JSON を返す。
- 配列に、`keytype` と `scheme` がともに `ecdsa-sha2-nistp256`、`expires` が `null`、`keyid` が `SHA256:` で始まる要素が少なくとも 1 つある。
- その `keyid` が M-4 (2) の `signatures[0].keyid` と一致する（配信した署名の鍵が公開されている）。
- `config/upstreams.yml` に npm 型の upstream（例: 公開 npm レジストリ）がある場合、その upstream が公開する鍵も配列にマージされている。upstream が到達不能でも、本エンドポイント自体は 200 を返す（片方の失敗が全体を壊さない）。
- 認証必須である（PAT ヘッダ無しで呼ぶと 401）。

---

## M-6 npm クライアントによる署名検証

**前提条件**: M-4 と M-5 が期待どおりであること。npm が使える環境であること。

**操作手順**

```bash
# 作業用の一時ディレクトリで行う（既存プロジェクトの .npmrc を書き換えない）
WORKDIR=$(mktemp -d) && cd "$WORKDIR"
npm init -y >/dev/null

# レジストリと認証を一時ディレクトリ内の .npmrc にのみ設定する
{
  echo "@scope:registry=https://upm.example.com/api/v4/groups/my-group/"
  echo "registry=https://upm.example.com/api/v4/groups/my-group/"
  echo "//upm.example.com/api/v4/groups/my-group/:_authToken=\${GITLAB_PAT}"
} > "$WORKDIR/.npmrc"

npm install com.example.vpm.pkg@1.0.0
npm audit signatures
```

**期待される結果**

- `npm install` が成功し、`node_modules/com.example.vpm.pkg` が作られる。
- `npm audit signatures` が対象パッケージについて署名を検証し、`verified` の趣旨の結果を返す（`missing signature` や `invalid signature` にならない）。

**後始末**

```bash
cd / && rm -rf "$WORKDIR" && unset WORKDIR
```

**判定の注意**: npm のバージョンによって `npm audit signatures` の出力文言と、レジストリ URL の指定方法（末尾スラッシュの要否）が異なる。実施時の npm のバージョンを記録し、想定と異なる場合は出力全文を控えてから判定する。

---

## M-7 Unity Package Manager からの取得

**前提条件**: M-3 または M-4 が期待どおりであること。Unity エディタが使えること。

**操作手順**

1. Unity の認証情報ファイル（ユーザーのホームディレクトリの `.upmconfig.toml`）に、プロキシの URL とトークンの設定を追加する。値はエディタで直接編集し、ファイルの権限を所有者のみにする。
2. Unity プロジェクトの設定で Scoped Registry を追加する。URL にはプロキシのグループスコープの URL（`https://upm.example.com/api/v4/groups/my-group/`）を、スコープには対象パッケージのスコープ（`com.example`）を指定する。
   - **注意**: 設定画面のメニュー名・項目名は Unity のバージョンで異なる。実施時に画面で確認し、本手順書の記述と食い違う場合は実際の文言に合わせて本書を更新する（本項の文言は未検証）。
3. Package Manager を開き、追加したレジストリのパッケージ一覧を表示する。
4. 対象パッケージをインストールし、プロジェクトに取り込まれることを確認する。

**期待される結果**

- パッケージ一覧に対象パッケージとバージョンが表示される。
- インストールが成功し、`Packages/manifest.json` に依存として追加される。
- Unity のコンソールとプロキシのログ（`sudo journalctl -u gitlab-upm-proxy -n 100 --no-pager`）に、認証エラー・404・整合性エラーが出ていない。
- 依存パッケージがある場合、それらも解決される（`dependencies` と `vpmDependencies` のマージが機能している）。

---

## M-8 リクエストログに署名付きクエリが残らない

**前提条件**: M-4 で tarball の取得まで到達していること。

GitLab は tarball の URL に署名付きのクエリを付けることがあり、このプロキシはそれを上流へそのまま渡す。
つまりリクエスト URL には有効なダウンロード資格情報が乗りうる。ログへ URL をそのまま書くと、
署名の有効期限より長く残る資格情報がログに残る。プロキシは自身の `req_in` 行と Fastify 標準の
incoming request 行の両方でパスだけを記録する。

この確認が必要なのは、`ExecStart` の `--options` が欠けていても**起動もリクエスト処理も成功する**ためで、
症状はログを見るまで現れない。

**操作手順**

```bash
# 署名付きクエリを模したパラメータを付けて 1 回リクエストする（値はダミーでよい）
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "PRIVATE-TOKEN: ${GITLAB_PAT}" \
  "https://upm.example.com/api/v4/groups/my-group/com.example.vpm.pkg?signature=MANUAL-CHECK-VALUE"

# 直近のログに、そのパラメータ名と値が現れないことを確認する
sudo journalctl -u gitlab-upm-proxy -n 50 --no-pager | grep -c 'MANUAL-CHECK-VALUE'
```

**期待される結果**

- `grep -c` の結果が `0`。値がどのログ行にも現れない。
- 同じログに `req_in` の行があり、`path` がクエリを含まないパスだけになっている。
- Fastify の incoming request 行にも、`path` としてクエリ抜きのパスだけが出ている。

`0` にならない場合は `ExecStart` の `--options` を確認する（M-1 参照）。

---

## M-9 上流の障害が「不在」として報告されない

**前提条件**: M-1 が成功していること。VPM 型 upstream が設定されていること。

404 は「上流がその物は無いと確認した」という意味に限る。上流が応答できなかっただけの場合に 404 を返すと、
クライアントにも中間キャッシュにも「そのパッケージは消えた」と伝わってしまう。
到達できない上流は 502、プロキシ自身の処理の失敗は 500 になる。

**操作手順**

```bash
# (1) 実在しないパッケージ名（インデックスは正常に応答し、その名前を載せていない）
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "PRIVATE-TOKEN: ${GITLAB_PAT}" \
  "https://upm.example.com/api/v4/groups/my-group/com.example.vpm.does-not-exist"

# (2) 到達できない VPM upstream
# config/upstreams.yml の VPM 型 upstream の baseUrl を一時的に到達不能な URL へ変え、
# サービスを再起動してから、その upstream が担当するパッケージを取得する。
# 確認後は必ず設定を元へ戻して再起動する。
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "PRIVATE-TOKEN: ${GITLAB_PAT}" \
  "https://upm.example.com/api/v4/groups/my-group/com.example.vpm.pkg"

sudo journalctl -u gitlab-upm-proxy -n 30 --no-pager | grep -n 'vpm_metadata_failed'
```

**期待される結果**

- (1) が `404`。インデックスが正常に応答してその名前を載せていない場合は、確認された不在である。
- (2) が `502`。到達できない上流は不在ではない。あわせて `vpm_metadata_failed` のログが出ている。
- (2) の後、設定を戻して再起動すると、同じ URL が再び `200` を返す。
  **キャッシュが消えていないこと**（障害を撤回と解釈して削除していないこと）をここで確認する。

---

## M-10 npm 中継 tarball のストリーム配信とキャッシュ

**前提条件**: M-2 の (3) が 200 であること。GitLab 側に npm パッケージ（VPM 由来ではないもの）が 1 つあること。

npm 中継の tarball は、応答全体をメモリへ読み込まずにクライアントへ流しながら、同時にキャッシュへ書く。
確認したいのは 3 点ある。アーカイブが欠けずに届くこと、キャッシュへ公開されること、そして
**キャッシュの公開が応答の完了より後になりうる**こと。1 つのストリームを分岐させているためで、
取得直後にキャッシュを見て「無い」と判断しないための注意点である。

`MAX_UPSTREAM_BODY_BYTES` を超えるアーカイブは、中継はされるがキャッシュされない
（この上限は保存してよい大きさを決めるもので、取得の可否を決めるものではない）。

**操作手順**

```bash
# 対象パッケージとバージョンは自分の環境の値へ読み替える
PKG=com.example.npmpkg
VER=1.0.0

# (1) キャッシュを消してから取得する
sudo rm -rf "/var/lib/gitlab-upm-proxy/cache/gitlab.example.com/${PKG}"
curl -s -H "PRIVATE-TOKEN: ${GITLAB_PAT}" \
  -o /tmp/npm-pkg.tgz -w '%{http_code} %{size_download}\n' \
  "https://upm.example.com/api/v4/groups/my-group/${PKG}/-/${PKG}-${VER}.tgz"

# (2) アーカイブとして展開できることを確認する（内容が欠けていないこと）
tar -tzf /tmp/npm-pkg.tgz | head -5

# (3) キャッシュの出現を待つ（応答完了より後になりうるため、即座に見ない）
for i in $(seq 1 20); do
  [ -f "/var/lib/gitlab-upm-proxy/cache/gitlab.example.com/${PKG}/${PKG}-${VER}.tgz" ] && break
  sleep 1
done
sudo ls -l "/var/lib/gitlab-upm-proxy/cache/gitlab.example.com/${PKG}/"

# (4) 2 回目の取得（キャッシュから返ることの確認。上流には認可確認の HEAD だけが飛ぶ）
curl -s -H "PRIVATE-TOKEN: ${GITLAB_PAT}" \
  -o /tmp/npm-pkg-2.tgz -w '%{http_code}\n' \
  "https://upm.example.com/api/v4/groups/my-group/${PKG}/-/${PKG}-${VER}.tgz"
cmp /tmp/npm-pkg.tgz /tmp/npm-pkg-2.tgz && echo "IDENTICAL"
```

**期待される結果**

- (1) が `200` を返し、`size_download` が上流のアーカイブサイズと一致する。
- (2) `tar -tzf` がエントリを列挙する（切り詰められていない）。
- (3) キャッシュに `<パッケージ名>-<バージョン>.tgz` が現れ、`.tmp` で終わるファイルが残っていない。
- (4) `200` が返り、`cmp` が `IDENTICAL` を表示する。
- プロキシのログに `tarball_cache_write_failed` が出ていない。

---

## 結果記録表

実施のたびに行を追加する。**エージェントはこの表を代筆しない**（実機確認は実施者本人の観察に基づく記録とするため）。

| ケース | 実施日 | 実施者 | 対象コミット | 結果 | 備考 |
|---|---|---|---|---|---|
| M-1 サーバー起動 | | | | | |
| M-2 PAT 認証 | | | | | |
| M-3 検索・メタデータ | | | | | |
| M-4 VPM 署名の付与・永続化・再利用 | | | | | |
| M-5 署名鍵エンドポイント | | | | | |
| M-6 npm クライアントでの署名検証 | | | | | |
| M-7 Unity からの取得 | | | | | |
| M-8 ログに署名付きクエリが残らない | | | | | |
| M-9 上流障害が不在として報告されない | | | | | |
| M-10 npm 中継のストリーム配信とキャッシュ | | | | | |

不合格だったケースは、対象コミット・実行したコマンド・出力（秘密情報を除く）・ログの該当箇所を控えたうえで報告する。
