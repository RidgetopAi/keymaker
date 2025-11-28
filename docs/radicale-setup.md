# Radicale CalDAV Server Setup for Keymaker

**Phase 2 Complete**: 2025-11-28

---

## VPS Production Setup (hetzner-vps) - ACTIVE

### Installation
```bash
# Install pipx first (if needed)
sudo apt install -y pipx

# Install Radicale via pipx
pipx install radicale
pipx inject radicale bcrypt
```

### Configuration

**Config file**: `/root/.config/radicale/config`
```ini
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = /root/.config/radicale/users
htpasswd_encryption = bcrypt

[storage]
filesystem_folder = /root/.local/share/radicale/collections

[rights]
type = owner_only

[logging]
level = info
```

### Systemd Service

**Service file**: `/etc/systemd/system/radicale.service`
```ini
[Unit]
Description=Radicale CalDAV Server
After=network.target

[Service]
Type=simple
User=root
ExecStart=/root/.local/bin/radicale
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Enable and start**:
```bash
systemctl daemon-reload
systemctl enable radicale
systemctl start radicale
```

### Calendar Collection
- **CalDAV URL**: `http://127.0.0.1:5232/ridgetop/keymaker/`
- **Storage**: `/root/.local/share/radicale/collections/collection-root/ridgetop/keymaker/`

### Verify
```bash
systemctl status radicale
curl -u ridgetop:PASSWORD http://127.0.0.1:5232/ridgetop/
```

---

## Local Machine Setup (Development)

### Installation
```bash
# Install via pipx (avoids system Python conflicts)
pipx install radicale
pipx inject radicale bcrypt
```

### Configuration

**Config file**: `~/.config/radicale/config`
```ini
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = /home/ridgetop/.config/radicale/users
htpasswd_encryption = bcrypt

[storage]
filesystem_folder = /home/ridgetop/.local/share/radicale/collections

[rights]
type = owner_only

[logging]
level = info
```

### Authentication

**Users file**: `~/.config/radicale/users`
```
ridgetop:<bcrypt-hash>
```

Generate hash:
```bash
~/.local/share/pipx/venvs/radicale/bin/python3 -c "
import bcrypt
password = 'YOUR_PASSWORD'
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
print(f'ridgetop:{hashed}')
" > ~/.config/radicale/users
```

### User Systemd Service

**Service file**: `~/.config/systemd/user/radicale.service`
```ini
[Unit]
Description=Radicale CalDAV Server
After=network.target

[Service]
Type=simple
ExecStart=/home/ridgetop/.local/bin/radicale
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

**Enable and start**:
```bash
systemctl --user daemon-reload
systemctl --user enable radicale
systemctl --user start radicale
loginctl enable-linger ridgetop  # Survive logout
```

### Calendar Collection

The `keymaker` calendar is created at:
- **CalDAV URL**: `http://localhost:5232/ridgetop/keymaker/`
- **Storage path**: `~/.local/share/radicale/collections/collection-root/ridgetop/keymaker/`

---

## VPS Deployment (For Remote Access)

### Prerequisites
```bash
ssh hetzner-vps
pip3 install --user radicale bcrypt
# Or use pipx if available
```

### Nginx Reverse Proxy

Add to nginx config:
```nginx
location /caldav/ {
    proxy_pass http://127.0.0.1:5232/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Calendar App Settings

**iOS Calendar**:
- Account Type: CalDAV
- Server: `https://ridgetopai.com/caldav`
- Username: `ridgetop`
- Password: (your password)
- Calendar Path: `/ridgetop/keymaker/`

**Android (DAVx⁵)**:
- Base URL: `https://ridgetopai.com/caldav/ridgetop/`
- Login with username/password

---

## Testing

### Verify Service Running
```bash
systemctl --user status radicale
```

### Test Authentication
```bash
curl -u ridgetop:PASSWORD http://127.0.0.1:5232/ridgetop/
```

### Create Test Event
```bash
curl -u ridgetop:PASSWORD -X PUT \
  http://127.0.0.1:5232/ridgetop/keymaker/test.ics \
  -H "Content-Type: text/calendar" \
  -d 'BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Keymaker//EN
BEGIN:VEVENT
UID:test@keymaker
DTSTART:20251201T100000Z
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR'
```

### Delete Test Event
```bash
curl -u ridgetop:PASSWORD -X DELETE \
  http://127.0.0.1:5232/ridgetop/keymaker/test.ics
```

---

## Keymaker Integration (Phase 3)

Keymaker will sync events using these CalDAV operations:

| Operation | HTTP Method | Endpoint |
|-----------|-------------|----------|
| Create event | PUT | `/ridgetop/keymaker/{uid}.ics` |
| Update event | PUT | `/ridgetop/keymaker/{uid}.ics` |
| Delete event | DELETE | `/ridgetop/keymaker/{uid}.ics` |

**Event UID format**: `keymaker-commitment-{id}@localhost`

---

## Troubleshooting

### Service won't start
```bash
journalctl --user -u radicale -n 50
```

### Permission denied
Ensure storage directory exists and is writable:
```bash
mkdir -p ~/.local/share/radicale/collections
```

### Auth failures
Verify htpasswd file format and bcrypt hash:
```bash
cat ~/.config/radicale/users
```
