# 生产部署报告 — <SERVER_HOST>

> 部署日期：2026-08-22 ｜ 部署人：Azrael（ZCode 辅助）｜ 服务版本：commit `c4e2192`

## 1. 部署概览

| 项目 | 值 |
| :--- | :--- |
| 服务地址 | **https://<SERVER_HOST>**（HTTP 80 自动 301 跳转 HTTPS） |
| Web 控制台 | `https://<SERVER_HOST>/`（⚙️ 设置中填 API Key 后即可录音识别） |
| 健康检查 | `GET https://<SERVER_HOST>/health`（含预算/限流/Ticket 状态） |
| Ticket 签发 | `POST https://<SERVER_HOST>/v1/ticket`（`Authorization: Bearer <API_KEY>`） |
| 实时 ASR | `wss://<SERVER_HOST>/v1/asr?ticket=<TICKET>` |
| API Key | 向管理员索取。配置在服务器 `/opt/asr-service/.env` 的 `AUTH_TOKENS`，形如 `asr-<32位hex>` |

**接入方请直接阅读 [client-integration-guide.md](./client-integration-guide.md)。**

## 2. 服务器环境

| 项目 | 值 |
| :--- | :--- |
| 主机 | 腾讯云 VM（OpenCloudOS 9.6，x86_64，2C / 2GB） |
| SSH | `ssh root@<SERVER_HOST>`（已配置本机 `~/.ssh/id_ed25519` 免密） |
| 安全组 | 已放行 22 / 80 / **443**（443 于 2026-08-22 手动放行） |
| Node.js | v22.23.2（官方二进制 tarball 安装于 `/usr/local`） |
| nginx | 1.29.8（dnf 安装） |
| certbot | 系统包 2.8（仅作依赖，不参与续期）+ venv 5.7（`/opt/certbot-venv`，负责 IP 证书签发与续期） |

## 3. 部署架构

```
浏览器/客户端
   │ HTTPS / WSS (:443)
   ▼
nginx（80→301→443；TLS 终结；WebSocket 升级头；X-Forwarded-For 透传）
   │ 127.0.0.1:8080（仅回环，不暴露公网）
   ▼
asr-service（systemd 守护，NODE_ENV=production）
   ├── Fastify 静态托管 public/（Web 控制台 + 浏览器版 SDK）
   ├── POST /v1/ticket、GET /health
   └── WS /v1/asr（静态 Token 直连 + Ticket 双通道鉴权）
```

- 代码目录：`/opt/asr-service`（`.env`、`data/usage.json` 独立保留，rsync 更新不覆盖）
- 反代配置：`/etc/nginx/conf.d/asr-service.conf`（读超时 3600s 适配长音频流）
- 用量持久化：`/opt/asr-service/data/usage.json`（预算熔断计数）

## 4. HTTPS 证书（Let's Encrypt 裸 IP 证书）

无域名场景使用了 Let's Encrypt 2026-01 起 GA 的** IP 地址证书**：

- SAN = `IP Address:<SERVER_HOST>`，正规公共 CA，浏览器无警告
- **有效期仅 6 天（160 小时）**，必须高频自动续期
- 签发方式（记录备忘）：`certbot ≥ 5.4` + `--ip-address <IP>` + `--preferred-profile shortlived` + **webroot 插件**（nginx/apache 插件尚不支持 IP 证书；`-d <IP>` 会直接报错）
- webroot：`/var/www/certbot`（nginx 80 端口 `/.well-known/acme-challenge/` 直读该目录）
- 证书路径：`/etc/letsencrypt/live/<SERVER_HOST>/`
- 续期定时器：systemd `asr-certbot-renew.timer`，**每 6 小时**跑 `/opt/certbot-venv/bin/certbot renew --deploy-hook` 重载 nginx；系统自带 certbot 2.8 的 timer 已停用（旧版不支持 IP 证书）
- 续期速率：约 1~2 张/天，远低于 Let's Encrypt 单 IP 50 张/7 天限额

> 若日后绑定域名：普通 `certbot -d <域名>` 即可换 90 天长证书，现有 timer 可一并接管。

## 5. 生产配置要点（相对本地 .env 的差异）

| 配置 | 生产值 | 说明 |
| :--- | :--- | :--- |
| `AUTH_TOKENS` | `asr-<随机hex>` | **强随机 Token**，仓库默认的 `default-client-token` 已失效（实测 401） |
| `HOST` | `127.0.0.1` | 只监听回环，流量必须过 nginx |
| `LOG_LEVEL` | `info` | 生产收敛日志 |
| `DEFAULT_PROVIDER` | `aliyun` | 与本地一致；控制台可按次切换 omlx/aliyun |

## 6. 运维手册

```bash
ssh root@<SERVER_HOST>

# 服务状态 / 日志 / 重启
systemctl status asr-service
journalctl -u asr-service -f          # 实时日志（含 Ticket 签发、鉴权、限流命中）
systemctl restart asr-service

# nginx
nginx -t && systemctl reload nginx

# 证书续期检查（下次触发时间、手动 dry-run）
systemctl list-timers asr-certbot-renew.timer
/opt/certbot-venv/bin/certbot renew --dry-run --webroot -w /var/www/certbot
```

### 发布更新流程

```bash
# 本地项目根目录执行（.env / data / node_modules 不会被覆盖）
rsync -az --exclude node_modules --exclude .git --exclude dist \
  --exclude .env --exclude data --exclude 'test/data' \
  ./ root@<SERVER_HOST>:/opt/asr-service/

# 服务器上
cd /opt/asr-service && npm install --no-audit --no-fund && npm run build
systemctl restart asr-service
```

### 更换 / 新增 API Key

编辑 `/opt/asr-service/.env` 的 `AUTH_TOKENS`（逗号分隔可多值），然后 `systemctl restart asr-service`。

### 故障排查速查

| 症状 | 排查 |
| :--- | :--- |
| 外网 443 连不上 | 腾讯云控制台安全组是否放行 443 TCP（历史上漏开过一次） |
| 证书过期告警 | `systemctl list-timers asr-certbot-renew.timer` 是否在跑；手动 `certbot renew` 看报错 |
| 领票 503 | 预算熔断触发，`/health` 看 `budget` 字段与 `tripReason`，次日自动恢复或调高 `BUDGET_*` |
| 领票 429 | 该 IP 当日 200 次额度用尽，次日自动重置 |
| WS 立即断开 4001 | Ticket 过期/已用（一次性），客户端应重新领票重连 |

## 7. 验收记录（2026-08-22）

- ✅ `GET /health` 外网 HTTPS 200，预算/限流状态正常
- ✅ 证书链：Let's Encrypt（CN=YE1）签发，SAN 含 IP，openssl 真实校验通过
- ✅ 控制台与 SDK 文件 HTTPS 200，API Key 输入框已上线
- ✅ HTTP → HTTPS 301 跳转生效
- ✅ 生产 Token 领票成功；错误 Key / `default-client-token` 均 401
- ✅ 外网 WSS 全链路：领票 → 握手（证书校验）→ start → `started`（omlx 引擎）
- ✅ 服务端日志确认限流按真实客户端 IP 计数（非 127.0.0.1），防护闸门生产生效
- ✅ 证书自动续期 timer 已启用并排期
