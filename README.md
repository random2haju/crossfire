# OT Traffic Visualizer

Local-only network traffic visualization tool for cyber threat hunting in OT/ICS environments.
Visualizes firewall log flows between IT, DMZ, and OT zones using a directional animated graph.

## Features

- **Three aggregation views**: Host-to-Host, Subnet-to-Subnet, Zone Summary
- **Color-by-Action**: green allow / red deny / orange drop
- **Color-by-Protocol**: distinct colors for Modbus, S7comm, DNP3, SSH, HTTP/S, NTP, Syslog, DNS, and more
- **Animated directional edges**: moving dash effect shows traffic direction
- **Rich filtering**: zone, IP, protocol, port, action, device, time range
- **Insights panel**: top talkers, top denied flows, top ports, cross-zone totals, new paths
- **Export**: filtered CSV and graph PNG screenshot
- **Dark analyst UI**: optimized for long sessions

---

## Requirements

- macOS (tested on macOS 13+)
- Python 3.11 or later
- `pip` (bundled with Python)
- Internet access on first run to load Cytoscape.js from CDN (or see Offline section)

---

## Setup

```zsh
# 1. Navigate to the project
cd ~/Desktop/ot-traffic-viz

# 2. Create a virtual environment
python3 -m venv venv
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt
```

---

## Run

```zsh
source venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

Open your browser at: **http://localhost:8000**

---

## Usage

1. Click **Import CSV** in the toolbar and select a firewall log CSV file.
   Use `sample_data/firewall_sample.csv` to try it immediately.

2. The graph renders with IT (blue), DMZ (yellow), and OT (red) zone containers.
   Nodes are hosts; edges are aggregated flows with direction arrows.

3. Switch aggregation using the **View** buttons: Host-to-Host / Subnet / Zone Summary.

4. Toggle **Color by: Action** or **Color by: Protocol** to switch edge color coding.

5. Use the **left sidebar** to filter by zone, IP, protocol, port, action, device, or time.

6. Click any node or edge to see details in the right panel.

7. Switch to the **Insights** tab to see top talkers, denied flows, and cross-zone totals.

8. Use **Export** to download filtered data as CSV or the graph as PNG.

---

## CSV Format

The parser accepts CSVs with these columns (many aliases supported):

| Canonical      | Aliases accepted                                      |
|----------------|-------------------------------------------------------|
| `timestamp`    | `time`, `datetime`, `event_time`, `receive_time`      |
| `src_ip`       | `source_ip`, `src_addr`, `sourceip`, `client_ip`      |
| `dst_ip`       | `destination_ip`, `dst_addr`, `dest_ip`, `server_ip`  |
| `src_port`     | `source_port`, `sport`, `sourceport`                  |
| `dst_port`     | `destination_port`, `dport`, `dest_port`              |
| `protocol`     | `proto`, `ip_protocol`, `transport`                   |
| `action`       | `verdict`, `disposition`, `policy_action`, `result`   |
| `bytes`        | `byte_count`, `total_bytes`, `bytes_sent`             |
| `device_name`  | `device`, `firewall`, `hostname`, `sensor`            |
| `src_zone`     | `source_zone`, `from_zone`, `ingress_zone`            |
| `dst_zone`     | `destination_zone`, `to_zone`, `egress_zone`          |

**Required**: `src_ip`, `dst_ip`. All other columns are optional.

### Zone normalization

Zone values are normalized automatically (case-insensitive):

| Zone | Matches                                          |
|------|--------------------------------------------------|
| IT   | `it`, `inside`, `lan`, `corp`, `internal`, `trusted` |
| DMZ  | `dmz`, `perimeter`, `semi-trusted`               |
| OT   | `ot`, `ics`, `scada`, `industrial`, `control`    |

---

## Project Structure

```
ot-traffic-viz/
├── backend/
│   ├── main.py          # FastAPI app, endpoints, static serving
│   ├── parser.py        # CSV normalization and alias mapping
│   ├── aggregator.py    # Three aggregation modes + filter logic
│   ├── models.py        # Pydantic request/response models
│   └── insights.py      # Summary panel computation
├── frontend/
│   ├── index.html       # Single-page app shell
│   ├── css/style.css    # Dark theme layout
│   └── js/
│       ├── app.js       # App init, upload, event wiring
│       ├── graph.js     # Cytoscape.js graph, styles, tooltips
│       ├── animation.js # RAF-based moving-dash animation
│       ├── filters.js   # Filter form and debounced API calls
│       └── export.js    # CSV and PNG export
├── sample_data/
│   └── firewall_sample.csv
├── requirements.txt
└── README.md
```

---

## API Endpoints

| Method | Path          | Description                              |
|--------|---------------|------------------------------------------|
| POST   | `/api/upload` | Upload and parse CSV                     |
| GET    | `/api/graph`  | Get graph data (nodes + edges)           |
| GET    | `/api/summary`| Get insights summary                     |
| GET    | `/api/export` | Download filtered data as CSV            |

Auto-generated docs available at: http://localhost:8000/docs

---

## Running Offline

By default, Cytoscape.js loads from cdnjs. To run fully offline:

```zsh
# Download Cytoscape.js
curl -L https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.29.2/cytoscape.min.js \
  -o frontend/js/cytoscape.min.js
```

Then edit `frontend/index.html` and change:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.29.2/cytoscape.min.js"></script>
```
to:
```html
<script src="/static/js/cytoscape.min.js"></script>
```

---

## Future Enhancements

- Syslog ingestion (UDP listener or file-based)
- Multi-vendor normalization (Palo Alto CEF, Cisco ASA, Fortinet CSV)
- Baseline comparison: flag flows not seen in a reference dataset
- Anomaly scoring: z-score on event count and bytes
- Time-series playback: animate flows by time window
- PCAP import support

---

## Troubleshooting

**Port already in use:**
```zsh
uvicorn backend.main:app --reload --port 8001
# then open http://localhost:8001
```

**Python version:**
```zsh
python3 --version   # should be 3.11+
brew install python  # upgrade via Homebrew if needed
```

**Venv not activating:**
```zsh
deactivate          # if another venv is active
source venv/bin/activate
```
