# dsh-web-login

给 DeepSeek Harness 网页界面添加**用户名 / 密码登录**，便于把实例公开到局域网访问。

**English** | [简体中文](README.zh.md)

> 本插件只做**准入控制**（admission control）。它不负责绑定端口、不接管 `/api` 信任栅栏、也不安装 systemd 服务。
> 局域网绑定请配合 [dsh-web-lan-access](https://github.com/AcidGr/dsh-web-lan-access)；systemd 用户服务请参考 [`systemd/`](systemd/)。

## 解决什么问题

DSH 默认每次启动都会生成一个**一次性 launch token**，并打印成
`dsh web: http://127.0.0.1:3080/?token=...`。用这个带 token 的 URL 首次访问后，
它会种下一个签名的 **browser-session cookie**。

问题在于：

1. token 每次重启都不同 —— 所以你必须每次去服务器终端里翻那个 URL；
2. 该 URL 不能直接分享到局域网 —— 别人拿到就等于拿到你的 shell。

本插件补上缺失的一环：**没有 token 时，把用户重定向到一个登录页**，让用户输入配置好的
用户名/密码，然后签发**与 token 登录完全相同的那个持久 cookie**。

关键点：cookie 的签名密钥并不在每次启动时重新生成 —— 它持久保存在
`$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录里。
因此只要登录成功一次，浏览器就会在 `cookieMaxAgeDays`（默认 30 天）内一直保持登录，
**跨重启、跨 token 变化都不受影响**。

## 工作原理

```
浏览器请求 GET /
   │
   ├─ 带 ?token=… ──► 交给 DSH 原生的 token 交换（行为完全不变，仍会种 cookie）
   │
   ├─ 带有效 cookie ──► 直接返回 index.html（正常进入 UI）
   │
   └─ 两者都没有 ──► 303 重定向到 /__login
                        │
                        └─ 用户提交用户名/密码
                             └─ 校验通过 ──► Set-Cookie（与原生 cookie 同构）──► 回到 ./
```

`/api`（RPC）和 `/api/remote.mux`（WebSocket）都走 DSH 原生的
`connection.admit()` 校验，它检查的正是这个 cookie —— 所以本插件**无需**改动或包装
RPC 路径，登录成功后它们自动生效。

## 安装

用 DSH 的插件管理器安装（推荐）：

```sh
dsh plugin --profile web add github:KagurazakaNyaa/dsh-web-login
```

或者让 DSH Agent 帮你装：

> 帮我安装这个插件：https://github.com/KagurazakaNyaa/dsh-web-login

安装后重启 `dsh`（或依赖 profile 的 live patch reload）。

## 配置凭据

两种方式，任选其一。

### 方式 A：环境变量（最简单）

在 systemd unit 或 shell 里设置：

```sh
export DSH_WEB_LOGIN_USER=admin
export DSH_WEB_LOGIN_PASSWORD='your-strong-password'
```

### 方式 B：凭据文件

```sh
node scripts/set-login.mjs --user admin --password 'your-strong-password'
# 默认写入 $DSH_HOME/web-login.json（0600，仅存 scrypt 哈希）
```

密码只以 **scrypt 哈希**形式落盘，明文不会写入。

## 局域网暴露

配合 [dsh-web-lan-access](https://github.com/AcidGr/dsh-web-lan-access) 即可：

```sh
dsh plugin --profile web add dsh-web-lan-access
```

它会：

* 把 `webserver.host` 设为 `0.0.0.0`；
* 依据当前所有非内部 IPv4（LAN / Tailscale / VPN）动态重算 `/api` 的 `trustedHosts`。

本插件的 bundle patch **刻意不改** `webserver` / `connection` 这两行，避免用静态列表
覆盖掉 lan-access 的动态表达式。

然后从局域网内任意设备访问：

```
http://<局域网IP>:3080/
```

会看到登录页；登录后进入正常 UI。

## systemd user unit

见 [`systemd/README.md`](systemd/README.md)。核心步骤：

```sh
cp systemd/dsh-web.service ~/.config/systemd/user/
# 编辑 Environment= 里的密码
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service
```

## 配置项（`cordis.patch.yml`）

```yaml
- id: web-login
  name: 'dsh-web-login'
  config:
    cookieMaxAgeDays: 30   # 登录有效期（天），与 client-connection 保持一致
    loginPath: ''          # 凭据文件路径；留空 = $DSH_HOME/web-login.json
    enabled: true          # false = 只保留 /__login 页面，不做重定向（退回纯 token 模式）
```

## 安全说明

* 本插件**不提供 TLS**。cookie 是 `HttpOnly` + `SameSite=Strict`，并经 HMAC 签名，
  但明文 HTTP 下局域网内可被嗅探/中间人。
* 仅用于**可信网络**，建议配合防火墙（如 `ufw allow from 192.168.0.0/16`）或
  Tailscale / 带认证的反向代理。
* 登录页有 150ms 固定延迟以缓解在线暴力破解，但没有账号锁定。请使用强密码。
* DSH 的 Agent 拥有 shell 权限 —— 能登录 UI 就等于能操作这台机器。请据此评估暴露范围。

## 已验证行为

在本机（dsh 0.2.0-rc.2，profile `web`，配合 `dsh-web-lan-access`）实测：

| 请求 | 结果 |
| --- | --- |
| `GET /` 无 token 无 cookie | `303` → `Location: /__login` |
| `GET /__login` | `200`（登录页） |
| `POST /__login` 密码错误 | `401` |
| `POST /__login` 密码正确 | `303` + `Set-Cookie: dsh-auth-…=v1.…; HttpOnly; SameSite=Strict` |
| `GET /` 带登录 cookie | `200`（正常 UI） |
| `POST /api` 带登录 cookie | 不再 401（由 `connection.admit()` 放行，未声明的端点返回 404） |
| `GET /?token=…` | 仍走原生 token 交换（有 bug 的 token → 401，行为不变） |

**跨重启持久化**：在第 1 次启动登录后，杀掉进程、重新启动（**token 已改变**），
用同一个 cookie 请求 `GET /` 仍返回 `200` —— 即登录不再依赖每次启动的 token。

## 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-web-login
```

移除后行为完全恢复为原生 token 登录；已种下的 cookie 仍然有效（它本来就是 DSH 原生的）。

## 开发

```sh
node --test test/
```

## License

AGPL-3.0-or-later
