# @kagurazakanyaa/dsh-web-login

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
dsh plugin --profile web add @kagurazakanyaa/dsh-web-login
```

也可以直接从 GitHub 源码装（不走 npm）：

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
  name: '@kagurazakanyaa/dsh-web-login'
  config:
    cookieMaxAgeDays: 30   # 登录有效期（天），与 client-connection 保持一致
    loginPath: ''          # 凭据文件路径；留空 = $DSH_HOME/web-login.json
    enabled: true          # false = 只保留 /__login 页面，不做重定向（退回纯 token 模式）
```

## 反向代理（nginx）

DSH 的 `/api` 有一道信任栅栏：**请求的 `Host` 必须与浏览器发出的 `Origin` 一致**，否则一律 403。
登录成功但"所有接口都 403"，几乎都是反代把 `Host` 改写成 `localhost` / `127.0.0.1` 造成的 ——
浏览器发的是 `Origin: https://你的域名`，而 DSH 收到的 `Host` 是 `localhost`，两者不匹配。

反代必须**原样透传 `Host`**：

```nginx
location / {
    proxy_pass         http://localhost:3080/;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Host              $host;              # 关键：不要写成 localhost
    proxy_set_header   X-Forwarded-Proto $scheme;            # 供 Secure Cookie 判断
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600;
}
```

同时启动 dsh 时要声明这个域名，让栅栏放行：

```sh
dsh web --port 3080 --trusted-host 你的域名
```

`X-Forwarded-Proto: https` 存在时，登录 Cookie 会自动带上 `Secure` 属性。

更省事的做法是配好 `map $http_upgrade $connection_upgrade`，WebSocket（`/api/remote.mux`）才能升级成功。

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
dsh plugin --profile web remove @kagurazakanyaa/dsh-web-login
```

移除后行为完全恢复为原生 token 登录；已种下的 cookie 仍然有效（它本来就是 DSH 原生的）。

## 开发

```sh
node --test
```

## 发布到 npm

包名是 **`@kagurazakanyaa/dsh-web-login`**（scoped + public，
`publishConfig.access` 已设为 `public`）。

发布**只由 GitHub Actions 完成**：推送一个 `v*` 标签即触发，本地不需要（也不应该）
手动 `npm publish`。

```sh
# 1. 确认 main 干净、测试通过
npm test

# 2. 升版本 —— npm version 会改 package.json、提交、并打上对应的 v 标签
npm version patch        # 1.0.0 -> 1.0.1
# npm version minor       # 1.0.0 -> 1.1.0
# npm version major       # 1.0.0 -> 2.0.0
# npm version prerelease --preid=rc   # 1.0.0 -> 1.0.1-rc.0

# 3. 推送提交和标签
git push --follow-tags
```

之后在 [仓库 Actions 页](https://github.com/KagurazakaNyaa/dsh-web-login/actions)
看到 `Publish to npm` 变绿，即表示
[@kagurazakanyaa/dsh-web-login](https://www.npmjs.com/package/@kagurazakanyaa/dsh-web-login) 已更新。

工作流里内置的几道防线：

* **标签必须和 `package.json` 对齐**（`v1.0.1` ↔ `"1.0.1"`），否则直接失败。
* **不覆盖已发布版本** —— npm 的版本是不可变的，重复发布没有意义，提前明确报错。
* **发布前必跑测试**（`npm test`，同时 `prepublishOnly` 也兜一道）。
* **检查 npm CLI 版本**：trusted publishing 要求 npm ≥ 11.5.1，所以 runner 用 Node 24。
* **npm provenance**：走 OIDC 发布时 npm 会自动签名，产物带上构建来源的加密签名，
  使用者可验证这个包确实出自本仓库的这个标签提交。

另有一个 `Test` workflow，会在 push 到 main 和每个 PR 时跑
Node 20/22 × Linux/macOS/Windows 矩阵测试，并做一次 `npm pack --dry-run`
确保 `files` 列表没有漏文件。

### 一次性配置：npm Trusted Publishing（OIDC）

发布用 **npm Trusted Publishing**，仓库里**不需要 `NPM_TOKEN`**，也就没有长期 token
需要轮换或泄露：GitHub Actions 每次发布会用 OIDC 换一个短期凭据。

> 早先的设计是 `NPM_TOKEN` + `npm publish`，在开了 2FA 的账号上会直接失败：
> `npm error code EOTP`。token 没勾 "Bypass 2FA for automation" 时，npm 在发布环节
> 仍会索要一次性密码，而 CI 里没人能输入。改用 OIDC 后这个问题不再存在。

#### 为什么首次发布不能用 OIDC

**npm 的 trusted publisher 只能绑定到已经存在于 registry 上的包名。** npm CLI 的
前置条件写得很直白：

> Package must exist: The package you're configuring must already exist on the
> npm registry.

这就是第一次推送 `v1.0.0` 标签时报 `ENEEDAUTH` 的原因：registry 里还没有
`@kagurazakanyaa/dsh-web-login` 这个包，OIDC 找不到信任关系，静默回退到 token，
而 token 已经被删掉了。

`npm publish` 本身至今仍不支持给不存在的包名建包，上游的功能请求还开着
（[npm/cli#8544](https://github.com/npm/cli/issues/8544)）。**但 `npm stage publish`
已经支持了** —— 见下面第 0 步，这也是现在推荐的引导方式。

#### 一次性引导：让包名先存在

**第 0 步（推荐）：用 `npm stage publish` 建包，全程不需要 2FA。**

npm 从 2026-10 起支持 `npm stage publish` 创建新包：它会先放一个
`0.0.0-stage` 占位版本（公开可装，但内容不公开），等你批准后才正式发布。
`npm stage publish` **不需要 2FA**，只要一个普通的 Granular access token ——
不需要勾 "Bypass 2FA for automation"，所以不踩正在被废弃的那条路。

```sh
# npm >= 11.15.0；在仓库根目录执行
npm stage publish @kagurazakanyaa/dsh-web-login@1.0.0 \
  --access public \
  --registry=https://registry.npmjs.org
```

然后批准它（这一步**需要** 2FA，用网页或 CLI 都行）：

```sh
npm stage list @kagurazakanyaa/dsh-web-login   # 拿到 stage-id
npm stage approve <stage-id> --registry=https://registry.npmjs.org
```

包名自此存在于 registry，可以进入下一步。

**第 1 步：挂 trusted publisher。**

```sh
# npm >= 11.15.0；--allow-publish 不能省
npm trust github @kagurazakanyaa/dsh-web-login \
  --repo KagurazakaNyaa/dsh-web-login \
  --file publish.yml \
  --allow-publish
```

网页端等价操作：`Packages → @kagurazakanyaa/dsh-web-login → Settings → Trusted publishing`，
填 `KagurazakaNyaa` / `dsh-web-login` / `publish.yml`，
Allowed actions 选 **`npm publish`**。

**第 2 步：收紧权限。**

在 `Settings → Publishing access` 里选
**"Require two-factor authentication and disallow tokens"**，禁掉长期 token。

**第 3 步：清理 secret。**

```sh
gh secret remove NPM_TOKEN --repo KagurazakaNyaa/dsh-web-login
```

之后推送 `v*` 标签即由 OIDC 自动发布，仓库里不再保存任何 npm 凭据。

> **注意**：引导过程本身就把 `1.0.0` 发上去了，所以已经存在的 `v1.0.0` 标签不会再
> 触发发布（工作流会以"已发布"拒绝）。下一个版本请先 `npm version patch`
> 升到 `1.0.1`，再推标签，那一次开始才是真正的 OIDC 自动发布。

> 不想用 staged 流程的话，也可以退回老办法：用带 "Bypass 2FA for automation" 的
> token 直接 `npm publish` 首个版本。但 npm 已公告 2027 年 1 月起 2FA-bypass token
> 会彻底失去直接发布能力，所以别把它写进长期方案。

### 容易踩的点

* **新配置 2 天内必须完成首次成功发布**，否则配置过期，只能删掉重建。
* 2026-09-03 之后新建的配置默认**只允许 `npm stage publish`**；不显式放开
  `npm publish` 的话，正常发布会因权限不足失败。
* `package.json` 里的 `repository.url` 必须和 GitHub 仓库完全一致，OIDC 校验会比对。
* 只支持 GitHub 托管的 runner，自托管 runner 不行。
* `actions/setup-node` 配了 `registry-url` 后会在 `.npmrc` 写一行
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`。没有 token 时它展开成空串，
  npm 会误以为"已有认证"、**跳过 OIDC**，报 `ENEEDAUTH` / 404。`publish.yml`
  里因此显式删掉了这一行
  （见 [npm/documentation#1960](https://github.com/npm/documentation/issues/1960)）。
* OIDC 失败时 npm **只记 verbose 日志**，然后静默回退到 token 认证。
  `ENEEDAUTH` 同时意味着"没配 token"和"OIDC 没匹配上"，排查时别被误导；
  加 `--loglevel verbose` 才能看到断在哪一步。
* 每个包同时最多 10 个 trusted publisher；已建立的连接不能改，只能删了重建。

## License

AGPL-3.0-or-later
