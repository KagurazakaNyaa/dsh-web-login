# dsh-web-login

English | [简体中文](#简体中文)

> **简体中文版**（与英文版内容一致）

给 DeepSeek Harness 网页界面添加**用户名 / 密码登录**，便于把实例公开到局域网访问。

## 这是什么

本插件只做**准入控制**（admission control）：

* **不**绑定端口 —— 局域网绑定请用 [dsh-web-lan-access](https://github.com/AcidGr/dsh-web-lan-access)；
* **不**接管 `/api` 的 Origin/Host 信任栅栏 —— 同样交给 lan-access；
* **不**安装或管理 systemd —— 那属于部署环境配置，参考 [`systemd/`](systemd/) 手动完成。

行为：当浏览器**没有**带 `?token=…` 时，把它重定向到登录页，让用户输入配置好的
用户名/密码登录，然后签发给它一个与原生 token 登录完全相同的持久 cookie。

## 为什么能摆脱 token

DSH 每次启动的 launch token 只是一把**一次性的钥匙**，用来换取一个签名的
browser-session cookie。而 cookie 的**签名密钥是持久化的**，存放在
`$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 里，重启不变。

所以本插件直接用这个持久密钥签发同构 cookie —— 登录一次即可长期保持，**不再依赖
每次启动的 token**。

## 安装

```sh
dsh plugin --profile web add github:KagurazakaNyaa/dsh-web-login
```

安装后重启 `dsh`。

## 配置凭据

**方式 A：环境变量**

```sh
export DSH_WEB_LOGIN_USER=admin
export DSH_WEB_LOGIN_PASSWORD='你的强密码'
```

**方式 B：凭据文件**（仅存 scrypt 哈希）

```sh
node scripts/set-login.mjs --user admin --password '你的强密码'
# 写入 $DSH_HOME/web-login.json，权限 0600
```

## 局域网暴露

配合 lan-access：

```sh
dsh plugin --profile web add dsh-web-lan-access
```

然后访问 `http://<局域网IP>:3080/`，看到登录页即表示工作正常。

## systemd

```sh
cp systemd/dsh-web.service ~/.config/systemd/user/
# 编辑 Environment= 里的密码
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service
```

## 配置项

```yaml
- id: web-login
  name: 'dsh-web-login'
  config:
    cookieMaxAgeDays: 30
    loginPath: ''
    enabled: true
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

## 安全提醒

* 无 TLS，明文 HTTP 可被嗅探；仅用于可信网络，建议加防火墙或走 Tailscale / 反代。
* 有 150ms 固定延迟缓解暴力破解，但无账号锁定，请用强密码。
* 能登录 UI 等于能操作这台机器的 shell，请注意暴露范围。

## License

AGPL-3.0-or-later
