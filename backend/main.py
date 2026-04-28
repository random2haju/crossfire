import io
import logging
import uuid
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .parser import parse_csv
from .aggregator import apply_filters, aggregate_host, aggregate_subnet, aggregate_zone
from .insights import compute_summary

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
LOG_FILE = Path(__file__).parent.parent / "crossfire_debug.log"

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("crossfire")

app = FastAPI(title="OT Traffic Visualizer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# File registry: {file_id: {"df": DataFrame, "name": str, ...metadata}}
_files: dict[str, dict] = {}
# Concatenated view rebuilt on every add/remove
_combined: Optional[pd.DataFrame] = None
# Topology map: {device_name: position_id}
_topology: dict[str, str] = {}

# Zone remapping per firewall boundary position.
# After normalize_zone converts raw interface roles (lan→IT, dmz→DMZ, wan→WAN),
# this table corrects them based on where the firewall actually sits.
POSITION_ZONE_REMAP: dict[str, dict[str, str]] = {
    # Firewall sits between WAN and IT — lan=IT, wan=WAN. No correction needed.
    'wan-it':  {'IT': 'IT',  'DMZ': 'DMZ', 'OT': 'OT',  'WAN': 'WAN'},
    # Firewall sits between IT and DMZ — lan=IT, dmz=DMZ. Already correct.
    'it-dmz':  {'IT': 'IT',  'DMZ': 'DMZ', 'OT': 'OT',  'WAN': 'WAN'},
    # Firewall sits between WAN and DMZ — its "lan" is actually DMZ.
    'wan-dmz': {'IT': 'DMZ', 'DMZ': 'WAN', 'OT': 'OT',  'WAN': 'WAN'},
    # Firewall sits between DMZ and OT — its "lan" is OT, its "dmz" is DMZ.
    'dmz-ot':  {'IT': 'OT',  'DMZ': 'DMZ', 'OT': 'OT',  'WAN': 'WAN'},
}


def apply_topology_remap(df: pd.DataFrame) -> pd.DataFrame:
    """Remap src_zone/dst_zone per device based on stored topology positions."""
    if not _topology or df.empty:
        return df
    df = df.copy()
    for device, position in _topology.items():
        remap = POSITION_ZONE_REMAP.get(position)
        if not remap:
            continue
        mask = df["device_name"] == device
        if not mask.any():
            continue
        df.loc[mask, "src_zone"] = df.loc[mask, "src_zone"].map(
            lambda z, r=remap: r.get(z, z)
        )
        df.loc[mask, "dst_zone"] = df.loc[mask, "dst_zone"].map(
            lambda z, r=remap: r.get(z, z)
        )
        log.info(f"Topology remap applied: {device} @ {position}")
    return df


def _strip_tz(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure timestamp column is always tz-naive before concat."""
    if "timestamp" not in df.columns:
        return df
    if isinstance(df["timestamp"].dtype, pd.DatetimeTZDtype):
        df = df.copy()
        df["timestamp"] = df["timestamp"].dt.tz_convert("UTC").dt.tz_localize(None)
    return df


def _rebuild():
    global _combined
    if not _files:
        _combined = None
        return
    _combined = pd.concat(
        [_strip_tz(m["df"]) for m in _files.values()], ignore_index=True
    )


def _unique_name(name: str) -> str:
    """Append a counter to the name if it already exists in the registry."""
    existing = {m["name"] for m in _files.values()}
    if name not in existing:
        return name
    stem, _, ext = name.rpartition(".")
    base = stem if stem else name
    suffix = f".{ext}" if stem else ""
    i = 2
    while True:
        candidate = f"{base} ({i}){suffix}"
        if candidate not in existing:
            return candidate
        i += 1


def _file_meta(file_id: str, name: str, df: pd.DataFrame) -> dict:
    ts = df["timestamp"]
    return {
        "file_id": file_id,
        "name": name,
        "record_count": len(df),
        "time_min": ts.min().isoformat() if ts.notna().any() else None,
        "time_max": ts.max().isoformat() if ts.notna().any() else None,
        "devices":   sorted(df["device_name"].unique().tolist()),
        "zones":     sorted(set(df["src_zone"].tolist() + df["dst_zone"].tolist())),
        "protocols": sorted(df["protocol"].unique().tolist()),
        "actions":   sorted(df["action"].unique().tolist()),
    }


def _combined_meta() -> dict:
    if _combined is None:
        return {"devices": [], "zones": [], "protocols": [], "actions": [],
                "time_min": None, "time_max": None}
    ts = _combined["timestamp"]
    return {
        "devices":   sorted(_combined["device_name"].unique().tolist()),
        "zones":     sorted(set(_combined["src_zone"].tolist() + _combined["dst_zone"].tolist())),
        "protocols": sorted(_combined["protocol"].unique().tolist()),
        "actions":   sorted(_combined["action"].unique().tolist()),
        "time_min":  ts.min().isoformat() if ts.notna().any() else None,
        "time_max":  ts.max().isoformat() if ts.notna().any() else None,
    }


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root():
    return (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    content = await file.read()
    size_mb = len(content) / 1_048_576
    log.info(f"Upload started: '{file.filename}' ({size_mb:.1f} MB)")
    log.debug(f"First 300 bytes: {content[:300]!r}")
    try:
        df = parse_csv(content)
        log.info(f"Parse OK: {len(df)} rows, cols={list(df.columns)}")
    except HTTPException as e:
        log.error(f"Parse HTTPException: {e.detail}")
        raise
    except Exception as e:
        import traceback
        log.error(f"Parse unexpected error: {traceback.format_exc()}")
        raise HTTPException(status_code=400, detail=f"Parse error: {type(e).__name__}: {e}")
    file_id = str(uuid.uuid4())
    name = _unique_name(file.filename or "unknown")
    meta = _file_meta(file_id, name, df)
    _files[file_id] = {**meta, "df": df}
    _rebuild()
    return {"status": "ok", **meta, **_combined_meta(),
            "total_records": len(_combined) if _combined is not None else 0,
            "file_count": len(_files)}


@app.get("/api/files")
async def list_files():
    return {
        "files": [
            {k: v for k, v in m.items() if k != "df"}
            for m in _files.values()
        ],
        "total_records": len(_combined) if _combined is not None else 0,
        **_combined_meta(),
    }


@app.delete("/api/files/{file_id}")
async def delete_file(file_id: str):
    if file_id not in _files:
        raise HTTPException(status_code=404, detail="File not found")
    del _files[file_id]
    _rebuild()
    return {
        "status": "ok",
        "file_count": len(_files),
        "total_records": len(_combined) if _combined is not None else 0,
        **_combined_meta(),
    }


@app.post("/api/files/clear")
async def clear_files():
    _files.clear()
    _rebuild()
    return {"status": "ok"}


@app.get("/api/graph")
async def get_graph(
    mode: str = Query("host"),
    subnet_mask: int = Query(24),
    time_start: Optional[str] = Query(None),
    time_end: Optional[str] = Query(None),
    src_zone: Optional[str] = Query(None),
    dst_zone: Optional[str] = Query(None),
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    protocol: Optional[str] = Query(None),
    dst_port: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    device_name: Optional[str] = Query(None),
    cross_zone_only: bool = Query(False),
):
    if _combined is None:
        return {"nodes": [], "edges": [], "record_count": 0}

    params = {
        "time_start": time_start, "time_end": time_end,
        "src_zone": src_zone, "dst_zone": dst_zone,
        "src_ip": src_ip, "dst_ip": dst_ip,
        "protocol": protocol, "dst_port": dst_port,
        "action": action, "device_name": device_name,
        "cross_zone_only": cross_zone_only,
    }
    filtered = apply_topology_remap(_combined.copy())
    filtered = apply_filters(filtered, params)

    if mode == "subnet":
        nodes, edges = aggregate_subnet(filtered, mask=subnet_mask)
    elif mode == "zone":
        nodes, edges = aggregate_zone(filtered)
    else:
        nodes, edges = aggregate_host(filtered)

    ts = filtered["timestamp"]
    return {
        "nodes": nodes, "edges": edges,
        "record_count": len(filtered),
        "time_min": ts.min().isoformat() if ts.notna().any() else None,
        "time_max": ts.max().isoformat() if ts.notna().any() else None,
    }


@app.post("/api/topology")
async def save_topology(data: dict):
    global _topology
    _topology = data.get("topology", {})
    log.info(f"Topology updated: {_topology}")
    return {"status": "ok", "devices_mapped": len(_topology)}


@app.get("/api/topology")
async def get_topology_state():
    return {"topology": _topology, "remap_table": POSITION_ZONE_REMAP}


@app.get("/api/debug/log")
async def debug_log(lines: int = 80):
    """Return last N lines of the debug log file."""
    if not LOG_FILE.exists():
        return {"lines": ["No log file yet"]}
    text = LOG_FILE.read_text(encoding="utf-8", errors="replace")
    tail = text.splitlines()[-lines:]
    return {"lines": tail, "path": str(LOG_FILE)}


@app.get("/api/summary")
async def get_summary(
    time_start: Optional[str] = Query(None),
    time_end: Optional[str] = Query(None),
    src_zone: Optional[str] = Query(None),
    dst_zone: Optional[str] = Query(None),
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    protocol: Optional[str] = Query(None),
    dst_port: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    device_name: Optional[str] = Query(None),
    cross_zone_only: bool = Query(False),
):
    if _combined is None:
        return compute_summary(None)
    params = {
        "time_start": time_start, "time_end": time_end,
        "src_zone": src_zone, "dst_zone": dst_zone,
        "src_ip": src_ip, "dst_ip": dst_ip,
        "protocol": protocol, "dst_port": dst_port,
        "action": action, "device_name": device_name,
        "cross_zone_only": cross_zone_only,
    }
    filtered = apply_topology_remap(_combined.copy())
    filtered = apply_filters(filtered, params)
    return compute_summary(filtered)


@app.get("/api/events")
async def get_events(
    time_start: Optional[str] = Query(None),
    time_end: Optional[str] = Query(None),
    src_zone: Optional[str] = Query(None),
    dst_zone: Optional[str] = Query(None),
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    protocol: Optional[str] = Query(None),
    dst_port: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    device_name: Optional[str] = Query(None),
    cross_zone_only: bool = Query(False),
    limit: int = Query(200),
):
    if _combined is None:
        return {"events": [], "total": 0}
    params = {
        "time_start": time_start, "time_end": time_end,
        "src_zone": src_zone, "dst_zone": dst_zone,
        "src_ip": src_ip, "dst_ip": dst_ip,
        "protocol": protocol, "dst_port": dst_port,
        "action": action, "device_name": device_name,
        "cross_zone_only": cross_zone_only,
    }
    filtered = apply_topology_remap(_combined.copy())
    filtered = apply_filters(filtered, params)
    cols = ["timestamp", "src_ip", "dst_ip", "src_zone", "dst_zone",
            "action", "protocol", "dst_port", "bytes", "device_name"]
    cols = [c for c in cols if c in filtered.columns]
    rows = filtered[cols].head(limit)
    rows = rows.where(pd.notna(rows), None)
    return {"events": rows.to_dict(orient="records"), "total": len(filtered)}


@app.get("/api/export")
async def export_csv(
    mode: str = Query("host"),
    time_start: Optional[str] = Query(None),
    time_end: Optional[str] = Query(None),
    src_zone: Optional[str] = Query(None),
    dst_zone: Optional[str] = Query(None),
    src_ip: Optional[str] = Query(None),
    dst_ip: Optional[str] = Query(None),
    protocol: Optional[str] = Query(None),
    dst_port: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    device_name: Optional[str] = Query(None),
    cross_zone_only: bool = Query(False),
):
    if _combined is None:
        raise HTTPException(status_code=400, detail="No data loaded")

    params = {
        "time_start": time_start, "time_end": time_end,
        "src_zone": src_zone, "dst_zone": dst_zone,
        "src_ip": src_ip, "dst_ip": dst_ip,
        "protocol": protocol, "dst_port": dst_port,
        "action": action, "device_name": device_name,
        "cross_zone_only": cross_zone_only,
    }
    filtered = apply_topology_remap(_combined.copy())
    filtered = apply_filters(filtered, params)
    buf = io.StringIO()
    filtered.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=filtered_export.csv"},
    )
