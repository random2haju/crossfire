import io
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

app = FastAPI(title="OT Traffic Visualizer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# In-memory dataset
_df: Optional[pd.DataFrame] = None


@app.get("/", response_class=HTMLResponse)
async def root():
    html_path = FRONTEND_DIR / "index.html"
    return html_path.read_text(encoding="utf-8")


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    global _df
    content = await file.read()
    _df = parse_csv(content)
    ts = _df["timestamp"]
    return {
        "status": "ok",
        "record_count": len(_df),
        "columns": _df.columns.tolist(),
        "time_min": ts.min().isoformat() if ts.notna().any() else None,
        "time_max": ts.max().isoformat() if ts.notna().any() else None,
        "zones": sorted(set(_df["src_zone"].tolist() + _df["dst_zone"].tolist())),
        "protocols": sorted(_df["protocol"].unique().tolist()),
        "actions": sorted(_df["action"].unique().tolist()),
        "devices": sorted(_df["device_name"].unique().tolist()),
    }


@app.get("/api/graph")
async def get_graph(
    mode: str = Query("host", description="host | subnet | zone"),
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
    global _df
    if _df is None:
        return {"nodes": [], "edges": [], "record_count": 0}

    params = {
        "time_start": time_start, "time_end": time_end,
        "src_zone": src_zone, "dst_zone": dst_zone,
        "src_ip": src_ip, "dst_ip": dst_ip,
        "protocol": protocol, "dst_port": dst_port,
        "action": action, "device_name": device_name,
        "cross_zone_only": cross_zone_only,
    }
    filtered = apply_filters(_df.copy(), params)

    if mode == "subnet":
        nodes, edges = aggregate_subnet(filtered, mask=subnet_mask)
    elif mode == "zone":
        nodes, edges = aggregate_zone(filtered)
    else:
        nodes, edges = aggregate_host(filtered)

    ts = filtered["timestamp"]
    return {
        "nodes": nodes,
        "edges": edges,
        "record_count": len(filtered),
        "time_min": ts.min().isoformat() if ts.notna().any() else None,
        "time_max": ts.max().isoformat() if ts.notna().any() else None,
    }


@app.get("/api/summary")
async def get_summary():
    global _df
    return compute_summary(_df)


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
    global _df
    if _df is None:
        raise HTTPException(status_code=400, detail="No data loaded")

    params = {
        "time_start": time_start, "time_end": time_end,
        "src_zone": src_zone, "dst_zone": dst_zone,
        "src_ip": src_ip, "dst_ip": dst_ip,
        "protocol": protocol, "dst_port": dst_port,
        "action": action, "device_name": device_name,
        "cross_zone_only": cross_zone_only,
    }
    filtered = apply_filters(_df.copy(), params)

    buf = io.StringIO()
    filtered.to_csv(buf, index=False)
    buf.seek(0)

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=filtered_export.csv"},
    )
