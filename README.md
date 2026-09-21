# gitlab-upm-proxy

## Overview

**gitlab-upm-proxy** is a lightweight proxy server that bridges **Unity Package Manager (UPM)** and **GitLab Package Registry (npm)**.

This application forwards selected GitLab API and npm registry endpoints while:

- Using **Personal Access Tokens (PAT)** for authentication
- Acting as a transparent proxy (no package re-hosting)
- Rewriting `tarball` URLs so Unity can download packages through this proxy
- Supporting Unity-compatible access to **group-scoped** and **project-scoped** GitLab npm endpoints

The primary goal is to enable **Unity to consume private GitLab-hosted UPM packages** without complex client-side authentication or Verdaccio-like registries.

---

## Notice

This project is built using Fastify, which is licensed under the MIT License.  
Parts of this application and this README were created with the assistance of **ChatGPT** and **Codex**.  
Usage, modification, and redistribution of this software are governed by the terms described in the LICENSE file.

---

## Authentication

- Authentication is performed using **GitLab Personal Access Tokens (PAT)**
- Tokens are forwarded as-is to GitLab (`PRIVATE-TOKEN` or `Authorization` headers)
- The proxy itself does not manage users or sessions

---

## Forwarded / Supported Endpoints

The proxy accepts GitLab-style URLs and forwards them to the upstream GitLab instance or configured npm registries.  
Only the endpoints required for Unity Package Manager operation are supported.

### Supported Endpoints

| Incoming Endpoint (Proxy) | Purpose | Response Format | Notes |
|---|---|---|---|
| GET /api/v4/groups/:groupEnc/-/v1/search | Package search (Unity-compatible) | JSON (npm search v1-like) | Aggregates: the GitLab Groups Packages API plus every configured upstream, with each result kept only if that upstream is the one scope routing would use for it. A GitLab enumeration failure fails the whole search |
| GET /api/v4/groups/:groupEnc/<any> | Package metadata & registry access | JSON / Binary | Used when Unity treats the group root as the registry URL |
| GET /api/v4/projects/:projectId/packages/npm/<any> | Tarball download (project-level) | Binary (`.tgz`) | Required because GitLab npm tarballs are project-scoped |

### Notes

- No standalone implementation is provided for `/-/whoami` or `/-/all`
  - Under a group (`/api/v4/groups/:groupEnc/-/whoami`) they are passed through to GitLab like any
    other registry path
  - At the root (`/-/whoami`) they are not: the root `/-/*` route serves converted VPM tarballs
    only and answers 404 to anything that does not end in `.tgz`
- The proxy caches metadata and tarballs under `TARBALL_CACHE_DIR`
- All authorization and permission checks are enforced by GitLab

---

## Typical Use Case

1. Unity is configured with a **Scoped Registry**
2. The registry URL points to this proxy
3. Unity sends search, metadata, and tarball requests
4. The proxy routes requests to GitLab or configured npm registries
5. Responses are returned with minimal transformation

---

## Configuration

The following environment variables are required:

````
PUBLIC_BASE_URL=https://upm.example.com  
TARBALL_CACHE_DIR=./data/cache  
UPSTREAM_CONFIG_PATH=config/upstreams.yml
````

Required for VPM prefetch:

````
VPM_PREFETCH_INTERVAL_SEC=0.5
````

Optional limits on what one upstream archive may cost. A VPM package's zip is published by
whoever owns that package, so its size is not this proxy's to trust. The defaults are far above
any real Unity package; set them lower on a small cache volume. A value that is present but not a
positive integer fails at startup rather than falling back to the default.

````
VPM_MAX_DOWNLOAD_BYTES=536870912
VPM_MAX_EXTRACT_BYTES=1073741824
VPM_MAX_EXTRACT_ENTRIES=20000
````

The same ceiling applies to the metadata enrichment download and to the JSON of metadata, search,
VPM index and signing key responses. The npm passthrough streams a tarball to the client rather
than buffering it, so there the ceiling governs how large an archive may be written to the cache:
a larger one is still relayed in full, it is simply not stored. It is separate from the VPM
archive limits because the two kinds of traffic are configured independently:

````
MAX_UPSTREAM_BODY_BYTES=536870912
````

Cached tarballs and merged metadata are stored under:
`{TARBALL_CACHE_DIR}/{upstreamHost}/{packageName}/`

### Optional OAuth loopback ports

OAuth is configured separately from package authentication with `OAUTH_CLIENT_ID`,
`OAUTH_REDIRECT_URIS` (comma-separated), and optional `OAUTH_SCOPES` (default `read_api`).
It requires HTTPS for the default GitLab upstream and `PUBLIC_BASE_URL`.
Without OAuth configuration, package access continues to work as before.

By default, redirect URIs must match a configured entry exactly. To let a native client use
an OS-assigned loopback port, explicitly opt in individual registered URIs:

```text
OAUTH_REDIRECT_URIS=http://127.0.0.1:8765/callback
OAUTH_LOOPBACK_DYNAMIC_PORT_URIS=http://127.0.0.1:8765/callback
```

The second list must be an exact subset of the first. Surrounding whitespace and empty entries
are ignored, and duplicates keep their first position. Each dynamic entry must use the exact
`http://127.0.0.1:` prefix, an explicit decimal port from 1 to 65535 without leading zeros, and
a path starting with `/`. Query strings are allowed; userinfo, fragments, backslashes, whitespace,
non-ASCII characters, malformed percent escapes and paths that normalize to a different path are
not. IPv6, `localhost` and HTTPS are not supported by the dynamic option.

Only the port may change. Path and query must match literally, including percent-escape case,
query ordering and an empty trailing `?`. The actual redirect URI is preserved through authorize,
code exchange and refresh (when a redirect URI is supplied). Register the baseline URI in GitLab
as well; this option does not change the GitLab application.

`GET /auth/config` advertises `oauth.loopbackDynamicPortRedirectUris` only when OAuth is enabled
and the dynamic list is nonempty. `protocolVersion` remains 1. An unset or empty option preserves
the existing response shape and exact-match behavior. An invalid dynamic entry disables **all
OAuth**, including fixed redirects: config returns `oauth.enabled=false`, and other OAuth routes
return 404. Package/PAT routes remain available.

Clients must check the capability before selecting a free port, bind before opening the browser,
and use the same actual URI for authorization and code exchange. With a valid version-1 OAuth
configuration but no usable dynamic capability, clients use registered fixed ports. A fixed-port
conflict is an error, not permission to use another port. Unknown protocol versions or disabled
OAuth must not be bypassed with this fallback. Existing exact-match redirects remain supported.

Dynamic-port acceptance has been observed through the consent screen on GitLab CE 19.2.6;
successful callback and token exchange still require validation against the target deployment.

### Behind a reverse proxy

`TRUST_PROXY` is optional and unset by default, which leaves `req.ip` as the address of whoever
opened the connection. Behind a reverse proxy that address is the front end rather than the caller,
so every user of the deployment looks like one client - and the OAuth token endpoint's per-caller
rate limit then applies to all of them together. Naming the front ends fixes that:

````
TRUST_PROXY=127.0.0.1
````

Accepted values are a comma-separated list of addresses or CIDR ranges (also the shorthands
`loopback`, `linklocal` and `uniquelocal`), a hop count, or `true` / `false`. A value that is none
of these stops the server at startup rather than trusting more or less than intended.

**Prefer a list of addresses.** `true` trusts every address, which makes `req.ip` the leftmost
`X-Forwarded-For` entry - a value the caller writes. It is only safe where the front end overwrites
that header and the application port cannot be reached directly. The same applies to a hop count.

Which hop does what matters when there is more than one. The **outermost** front end - the one
clients reach - must replace `X-Forwarded-For` with the address it sees rather than append to
whatever arrived, since anything the client wrote is unverified. Every hop **inside** that boundary
must append instead, preserving the chain: a second front end that also replaces the header throws
away the caller and leaves `req.ip` pointing at the hop in front of it, which puts every user back
in one bucket. List all of those inner hops in `TRUST_PROXY` so Fastify walks past them to the
caller.

Setting this also makes Fastify honour the other forwarded headers, so the boundary should
overwrite or remove `X-Forwarded-Host` and `X-Forwarded-Proto` as well. URL rewriting is unaffected
either way: the proxy builds public URLs from `PUBLIC_BASE_URL`, never from the request host.

`nginx`'s `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` appends, which is what an
inner hop wants; at the boundary use `$remote_addr` instead.

Like the other server options, this is read from the `options` the application exports, which
`fastify start` only applies with `--options`. The `start` and `dev:start` scripts pass it.

Upstream registries are configured in a YAML (or JSON) file. The default upstream is GitLab.  
If a package scope matches an upstream entry, metadata and tarball requests for that package are
sent to that registry. Search is different: it queries GitLab and every configured upstream, then
drops any result whose name that upstream would not be the one to serve.

`scopes` must be a list of strings. A scalar value (`scopes: com.example.*`) is rejected at
startup: it used to be read one character at a time, and the `*` among them matched every
package, silently turning that entry into a catch-all for the whole proxy.

Sample config (`config/upstreams_sample.yml`). Copy this to `config/upstreams.yml` and edit as needed:

````
default:
  - baseUrl: https://gitlab.example.com
upstreams:
  - baseUrl: https://registry.npmjs.org
    scopes:
      - jp.hoge.*
      - com.piyo.*
  - baseUrl: https://package.openupm.com
    scopes:
      - com.fuga.*
````

To use a VPM registry, set `type: vpm` (case-insensitive) and point `baseUrl` to the VPM index:

````yaml
upstreams:
  - baseUrl: https://vpm.example.com/index.json
    type: vpm
    scopes:
      - dev.example.*
````

### VPM Behavior

- VPM packages are converted to npm-style metadata (`metadata.json`) and cached under `TARBALL_CACHE_DIR`.
- `dependencies` merges `dependencies` and `vpmDependencies`, then normalizes ranges to Unity-compatible values.
- `dist.tarball` is rewritten to `PUBLIC_BASE_URL/-/<package>-<version>.tgz`.
- Only versions with `dist.shasum` are returned in VPM metadata responses.
- Converted VPM tarballs are re-signed by this proxy with npm ECDSA registry signatures (`dist.integrity` and `dist.signatures`). Only VPM-derived tarballs are signed; responses from npm-type upstreams and GitLab are passed through unchanged.
- Signatures are computed once per tarball (during prefetch or on first download) and stored in the cached `metadata.json`. Cached versions signed with the current key are not re-signed on later requests; rotating the key triggers re-signing.
- The proxy publishes its signing key at `/-/npm/v1/keys` and `/api/v4/groups/<group>/-/npm/v1/keys`. The response also merges the keys advertised by configured npm-type upstreams (`<baseUrl>/-/npm/v1/keys`) so clients can verify passthrough packages with a single keys endpoint. Unreachable upstreams are skipped.
- The project-scoped endpoint (`/api/v4/projects/:projectId/packages/npm/*`) does not serve VPM packages and is not signed.
- Set `NPM_SIGNATURE_PRIVATE_KEY_PEM` or `NPM_SIGNATURE_KEY_PATH` to keep the signing key stable across deployments. If neither is set, a key is generated under `TARBALL_CACHE_DIR`.
- Author is normalized to `{ "name": "..." }`. If missing, it is injected into the tgz `package.json` from the VPM index author.

### Auth Enforcement

- Every request must include a valid GitLab PAT; the proxy validates it against the default GitLab (`/api/v4/user`).
- If the PAT is missing or invalid, the proxy returns `401`.
- PAT headers are forwarded only to the default GitLab upstream. Other upstreams receive no auth headers.

---

## Installation Guide (Ubuntu Server + n)

This guide assumes a fresh Ubuntu Server and uses `n` to manage Node.js.  
All steps are manual (no files are modified by this README).

### 1) System prerequisites

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y git curl build-essential
```

### 2) Install npm (bootstrap)

```bash
sudo apt-get install -y npm
```

### 3) Node.js with `n`

```bash
sudo npm install -g n
sudo n 20
node -v
npm -v
```

### 4) Install `fastify-cli` globally

```bash
sudo npm install -g fastify-cli
which fastify
# Example: /usr/local/bin/fastify
```

### 5) Clone the repository

```bash
sudo mkdir -p /opt/gitlab-upm-proxy
sudo chown -R $USER:$USER /opt/gitlab-upm-proxy
git clone https://github.com/AmariNoa/gitlab-upm-proxy.git /opt/gitlab-upm-proxy
cd /opt/gitlab-upm-proxy
```

### 6) Install dependencies and build

```bash
npm install
npm run build:ts
```

### 7) Create `upstreams.yml`

Create `/opt/gitlab-upm-proxy/config/upstreams.yml` and update the URLs/scopes:

```yaml
default:
  - baseUrl: https://gitlab.example.com
upstreams:
  - baseUrl: https://registry.npmjs.org
    scopes:
      - jp.hoge.*
      - com.piyo.*
  - baseUrl: https://package.openupm.com
    scopes:
      - com.fuga.*
```

### 8) Create cache directory

```bash
sudo mkdir -p /var/lib/gitlab-upm-proxy/cache
sudo chown -R $USER:$USER /var/lib/gitlab-upm-proxy /var/lib/gitlab-upm-proxy/cache
```

### 9) Create systemd service

Create `/etc/systemd/system/gitlab-upm-proxy.service`:

```
[Unit]
Description=gitlab-upm-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gitlab-upm-proxy
ExecStart=/usr/local/bin/fastify start --options -l info -a 0.0.0.0 -p 3000 /opt/gitlab-upm-proxy/dist/app.js
Environment=PUBLIC_BASE_URL=https://upm.example.com
Environment=TARBALL_CACHE_DIR=/var/lib/gitlab-upm-proxy/cache
Environment=UPSTREAM_CONFIG_PATH=/opt/gitlab-upm-proxy/config/upstreams.yml
Environment=VPM_PREFETCH_INTERVAL_SEC=5
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable gitlab-upm-proxy
sudo systemctl start gitlab-upm-proxy
sudo systemctl status gitlab-upm-proxy
```

### 10) Nginx reverse proxy (HTTP -> HTTPS)

```bash
sudo apt-get install -y nginx
```

Create `/etc/nginx/sites-available/upm.example.com.conf`:

```
server {
    listen 80;
    server_name upm.example.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name upm.example.com;

    ssl_certificate /etc/letsencrypt/live/upm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/upm.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 30s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/upm.example.com.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 11) HTTPS with Let’s Encrypt

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d upm.example.com
```

### 12) Firewall (optional)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

### 13) Smoke test

```bash
curl -I https://upm.example.com
curl "http://127.0.0.1:3000/api/v4/groups/<groupEnc>/-/v1/search?text=com.example&from=0&size=10"
```

---

## Update Guide (Ubuntu Server)

### 1) Stop the service

```bash
sudo systemctl stop gitlab-upm-proxy
```

### 2) Pull latest changes

```bash
cd /opt/gitlab-upm-proxy
git pull
```

### 3) Install dependencies

```bash
npm install
```

### 4) Build

```bash
npm run build:ts
```

### 5) Start the service

```bash
sudo systemctl start gitlab-upm-proxy
sudo systemctl status gitlab-upm-proxy
```

### 6) Smoke test (optional)

```bash
curl -I https://upm.example.com
```

---

## Current README (Original Content)

Below is the original README content generated by Fastify-CLI, preserved verbatim.

---

# Getting Started with Fastify-CLI

This project was bootstrapped with Fastify-CLI.

## Available Scripts

In the project directory, you can run:

### npm run dev

To start the app in dev mode.  
Open http://localhost:3000 to view it in the browser.

### npm start

For production mode.

### npm run test

Run the test cases.

## Learn More

To learn Fastify, check out the Fastify documentation:  
https://fastify.dev/docs/latest/
