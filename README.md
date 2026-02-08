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
Parts of this application and this README were created with the assistance of **ChatGPT**.  
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
| GET /api/v4/groups/:groupEnc/-/v1/search | Package search (Unity-compatible) | JSON (npm search v1-like) | Routes by scope: upstream npm registry if matched, otherwise GitLab Groups Packages API |
| GET /api/v4/groups/:groupEnc/<any> | Package metadata & registry access | JSON / Binary | Used when Unity treats the group root as the registry URL |
| GET /api/v4/projects/:projectId/packages/npm/<any> | Tarball download (project-level) | Binary (`.tgz`) | Required because GitLab npm tarballs are project-scoped |

### Notes

- No standalone implementation is provided for `/-/whoami` or `/-/all`
  - These endpoints are handled via transparent passthrough if requested
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

Cached tarballs and merged metadata are stored under:
`{TARBALL_CACHE_DIR}/{upstreamHost}/{packageName}/`

Upstream registries are configured in a YAML (or JSON) file. The default upstream is GitLab.  
If a package scope matches an upstream entry, search requests are sent to that registry.

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

### 8) Create `dist/plugins`

```bash
mkdir -p /opt/gitlab-upm-proxy/dist/plugins
```

### 9) Create cache directory

```bash
sudo mkdir -p /var/lib/gitlab-upm-proxy/cache
sudo chown -R $USER:$USER /var/lib/gitlab-upm-proxy /var/lib/gitlab-upm-proxy/cache
```

### 10) Create systemd service

Create `/etc/systemd/system/gitlab-upm-proxy.service`:

```
[Unit]
Description=gitlab-upm-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gitlab-upm-proxy
ExecStart=/usr/local/bin/fastify start -l info -a 0.0.0.0 -p 3000 /opt/gitlab-upm-proxy/dist/app.js
Environment=PUBLIC_BASE_URL=https://upm.example.com
Environment=TARBALL_CACHE_DIR=/var/lib/gitlab-upm-proxy/cache
Environment=UPSTREAM_CONFIG_PATH=/opt/gitlab-upm-proxy/config/upstreams.yml
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

### 11) Nginx reverse proxy (HTTP -> HTTPS)

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

### 12) HTTPS with Let’s Encrypt

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d upm.example.com
```

### 13) Firewall (optional)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

### 14) Smoke test

```bash
curl -I https://upm.example.com
curl "http://127.0.0.1:3000/api/v4/groups/<groupEnc>/-/v1/search?text=com.example&from=0&size=10"
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
