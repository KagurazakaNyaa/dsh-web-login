# systemd user unit (manual setup)

This plugin does **not** install or manage systemd. Running dsh under a
`systemd --user` unit is environment setup that belongs to the deployment, not
to the plugin. The unit below is provided as a reference you copy into place.

## Steps

```sh
# 1. Install the plugin (see repo root README), then:

# 2. Copy the unit into your user config
mkdir -p ~/.config/systemd/user
cp systemd/dsh-web.service ~/.config/systemd/user/dsh-web.service

# 3. Edit the Environment= lines: set a real DSH_WEB_LOGIN_PASSWORD
#    (or remove the env lines and use scripts/set-login.mjs to write a file).

# 4. Enable linger so the service starts without an active session
loginctl enable-linger "$USER"

# 5. Enable + start
systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service

# 6. Watch
journalctl --user -u dsh-web.service -f
```

This unit pairs with `dsh-web-lan-access`, which binds `0.0.0.0` and widens
the `/api` Origin fence. If you are not using that bundle, add
`--host 0.0.0.0` (note: the stock `dsh web --host 0.0.0.0` flag is rejected
for safety; the lan-access bundle sets the bind in its patch instead) or front
the server with a reverse proxy.

You can reach the UI at `http://<lan-ip>:3080/` from any device on the LAN and
sign in with the configured credentials.
