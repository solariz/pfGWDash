# pfGWDash

A lightweight monitoring solution for multiple pfSense instances. It polls pfSense devices, retrieves gateway and bandwidth information, and generates static HTML status pages.

The project consists of two independent services:
- **pfgw.py** — Gateway status monitor
- **pfbw.py** — Interface bandwidth monitor


## Features

- Monitor multiple pfSense instances from a single dashboard
- Real-time gateway status with visual indicators and data freshness
- Bandwidth graphs for specified interfaces with dynamic scaling
- Auto-refreshing HTML pages (no database required)
- Daemon mode with systemd integration


## Requirements

- Debian 12 (Bookworm) or Debian 13 (Trixie)
- Python 3.6+
- A web server to serve the generated HTML files (e.g. nginx)
- Network access to your pfSense instances
- A read-only user on each pfSense instance


## Installation

### 1. Clone the repository

```bash
cd /opt
git clone https://github.com/solariz/pfGWDash.git
cd pfGWDash
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

If `pip` fails due to system-managed Python (common on Debian 13+), you can install the packages system-wide via apt instead:

```bash
apt install python3-requests python3-bs4 python3-jinja2
```

### 3. Configure

Copy the sample config and edit it with your pfSense details:

```bash
cp config.sample.ini config.ini
vi config.ini
```

See [Configuration](#configuration) below for all available options.

### 4. Install and start the systemd services

```bash
cp pfgwdash.service pfbwdash.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pfgwdash.service
systemctl enable --now pfbwdash.service
```

Verify both services are running:

```bash
systemctl status pfgwdash.service
systemctl status pfbwdash.service
```

### 5. Set up a web server

The services generate static HTML files. You need a web server to serve them. Below is a minimal nginx setup.

```bash
apt install nginx
systemctl enable nginx
```

Remove the default content and symlink the static assets:

```bash
rm -rf /var/www/html/*
ln -s /opt/pfGWDash/web/pfbw.css /var/www/html/
ln -s /opt/pfGWDash/web/pfgw.js /var/www/html/
ln -s /opt/pfGWDash/web/pfbw.js /var/www/html/
ln -s /opt/pfGWDash/web/favicon.ico /var/www/html/
```

The default nginx configuration (`/etc/nginx/sites-enabled/default`) serving `/var/www/html/` on port 80 works out of the box. No changes needed.

The generated HTML files (`gateway_status.html`, `bw_status.html`) are written directly into `/var/www/html/` as configured in `config.ini`.


## Configuration

Edit `config.ini` to set up your environment:

```ini
[General]
html_output = /var/www/html/gateway_status.html
html_output_bw = /var/www/html/bw_status.html
poll_every = 30
debug = False

[PfSense_1]
name = GW1
url = https://fw1
username = readonlyusr
password = password

[PfSense_2]
name = GW2
url = https://fw2
username = readonlyusr
password = password

[Session]
auth_file = auth.json
expiry_hours = 1

[Gateways]
# Widget key of the Gateways widget on the pfSense dashboard.
# Use the key itself ("gateways-0"), not the DOM panel id
# ("widget-gateways-0_panel-body").
# The key must exist on the dashboard of the account used to poll
# so log in once with that account and add a Gateways widget.
widget_key = gateways-0
# Comma-separated gateway names to hide entirely (e.g. WAN4_GW,WAN5_GW)
ignore_gateway_by_name = WAN4_GW,WAN5_GW

[Bandwidth]
# Interfaces to monitor (comma-separated)
interfaces = opt1,opt2,opt3
poll_every = 10

[BandwidthMax]
# Starting value for dynamic scaling (in Mbps)
min_maxbw = 1000

# Optional: fixed max bandwidth per interface (overrides dynamic scaling)
opt1 = 800
opt2 = 800
opt3 = 500
```

| Section | Key | Description |
|---|---|---|
| `General` | `html_output` | Output path for the gateway status HTML |
| `General` | `html_output_bw` | Output path for the bandwidth status HTML |
| `General` | `poll_every` | Gateway polling interval in seconds |
| `General` | `debug` | Enable debug logging |
| `PfSense_*` | `name` | Display name for this instance |
| `PfSense_*` | `url` | URL of the pfSense web interface |
| `PfSense_*` | `username` | pfSense username (read-only recommended) |
| `PfSense_*` | `password` | pfSense password |
| `Session` | `auth_file` | Local file to cache session tokens |
| `Session` | `expiry_hours` | Session cache lifetime in hours |
| `Gateways` | `widget_key` | pfSense dashboard widget key (e.g. `gateways-0`) |
| `Gateways` | `ignore_gateway_by_name` | Comma-separated gateway names to hide entirely |
| `Bandwidth` | `interfaces` | Comma-separated list of interfaces to monitor |
| `Bandwidth` | `poll_every` | Bandwidth polling interval in seconds |
| `BandwidthMax` | `min_maxbw` | Base value for dynamic graph scaling (Mbps) |
| `BandwidthMax` | `<interface>` | Optional fixed max bandwidth per interface (Mbps) |

> **Gateways widget key:** `widget_key` is the key pfSense uses for the widget
> instance (e.g. `gateways-0`), **not** the HTML panel id
> (`widget-gateways-0_panel-body`). It must also exist on the dashboard of the
> account used for polling, otherwise pfSense replies `Invalid Widget Key` and
> no gateway data is returned.
>
> **Ignoring gateways:** `ignore_gateway_by_name` takes a comma-separated list of
> gateway names (e.g. `WAN4_GW,WAN5_GW`). Matching gateways are removed from the
> output entirely and are not reported in the packet-loss checks.

You can add as many `[PfSense_*]` sections as needed. Each must have a unique section name.


## Usage

### Manual / single execution

```bash
python3 /opt/pfGWDash/pfgw.py
python3 /opt/pfGWDash/pfbw.py
```

### Daemon mode

```bash
python3 /opt/pfGWDash/pfgw.py --daemon
python3 /opt/pfGWDash/pfbw.py --daemon
```

For production use, the systemd services (see [Installation step 4](#4-install-and-start-the-systemd-services)) are recommended.


## Security Considerations

- `config.ini` contains credentials — restrict file permissions accordingly.
- The generated HTML pages are served without authentication. Consider placing nginx behind a VPN or adding basic auth.
- Use a **read-only** pfSense user for monitoring.


## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## TODO
- Currently the daemon runs as root, this is bad practice and it should be changed either simple switch to the www user (e.g. www-data) or create a separated one.
- We coud use the data we poll anyway to store them additional in an rrd


## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
