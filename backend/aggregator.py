import ipaddress
import math
import pandas as pd
from typing import Optional


def apply_filters(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    if df is None or df.empty:
        return df

    if params.get("time_start"):
        ts = pd.to_datetime(params["time_start"], errors="coerce")
        if ts is not pd.NaT:
            df = df[df["timestamp"].isna() | (df["timestamp"] >= ts)]

    if params.get("time_end"):
        te = pd.to_datetime(params["time_end"], errors="coerce")
        if te is not pd.NaT:
            df = df[df["timestamp"].isna() | (df["timestamp"] <= te)]

    if params.get("src_zone"):
        zones = [z.strip().upper() for z in params["src_zone"].split(",")]
        df = df[df["src_zone"].isin(zones)]

    if params.get("dst_zone"):
        zones = [z.strip().upper() for z in params["dst_zone"].split(",")]
        df = df[df["dst_zone"].isin(zones)]

    if params.get("src_ip"):
        df = df[df["src_ip"].str.contains(params["src_ip"], na=False)]

    if params.get("dst_ip"):
        df = df[df["dst_ip"].str.contains(params["dst_ip"], na=False)]

    if params.get("protocol"):
        df = df[df["protocol"].str.upper() == params["protocol"].upper()]

    if params.get("dst_port"):
        df = df[df["dst_port"] == int(params["dst_port"])]

    if params.get("action"):
        df = df[df["action"] == params["action"].lower()]

    if params.get("device_name"):
        df = df[df["device_name"].str.contains(params["device_name"], na=False, case=False)]

    if params.get("cross_zone_only"):
        df = df[df["src_zone"] != df["dst_zone"]]

    return df


def _scale(val: float, mn: float, mx: float, out_min: float, out_max: float) -> float:
    if mx == mn:
        return (out_min + out_max) / 2
    return out_min + (val - mn) / (mx - mn) * (out_max - out_min)


def _dominant(series: pd.Series) -> str:
    if series.empty:
        return "unknown"
    return series.value_counts().index[0]


def _policy_fields(g: pd.DataFrame) -> dict:
    policies = (
        g["policyname"].dropna().unique().tolist()
        if "policyname" in g.columns else []
    )
    policyids = (
        sorted(g["policyid"].dropna().unique().tolist())
        if "policyid" in g.columns else []
    )
    devices = (
        sorted(g["device_name"].dropna().unique().tolist())
        if "device_name" in g.columns else []
    )
    policies  = [p for p in policies  if p and p != "nan"]
    policyids = [p for p in policyids if p and p != "nan"]
    devices   = [d for d in devices   if d and d != "nan"]
    return {"policies": policies, "policyids": policyids, "devices": devices}


def _zone_parent_id(zone: str) -> str:
    return f"{zone.lower()}-zone"


def _build_zone_nodes() -> list[dict]:
    return [
        {"data": {"id": "it-zone",  "label": "IT",  "zone": "IT",  "isZone": True}},
        {"data": {"id": "dmz-zone", "label": "DMZ", "zone": "DMZ", "isZone": True}},
        {"data": {"id": "ot-zone",  "label": "OT",  "zone": "OT",  "isZone": True}},
    ]


def aggregate_host(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    if df.empty:
        return _build_zone_nodes(), []

    # Aggregate edges
    grp = df.groupby(["src_ip", "dst_ip", "src_zone", "dst_zone"])
    edge_rows = []
    for (src_ip, dst_ip, src_zone, dst_zone), g in grp:
        count = len(g)
        bytes_total = int(g["bytes"].sum())
        dominant_action = _dominant(g["action"])
        dominant_protocol = _dominant(g["protocol"])
        protocols = sorted(g["protocol"].unique().tolist())
        ports = sorted(g["dst_port"].unique().tolist())
        allow_count = int((g["action"] == "allow").sum())
        deny_count = int((g["action"] == "deny").sum())
        weight = _scale(math.log1p(count), 0, math.log1p(df.shape[0]), 1, 8)
        edge_rows.append({
            "src_ip": src_ip, "dst_ip": dst_ip,
            "src_zone": src_zone, "dst_zone": dst_zone,
            "count": count,
            **_policy_fields(g),
            "bytes_total": bytes_total,
            "action": dominant_action,
            "protocol": dominant_protocol,
            "protocols": protocols,
            "ports": ports,
            "allow_count": allow_count,
            "deny_count": deny_count,
            "weight": round(weight, 2),
        })

    # Build node set
    node_map: dict[str, dict] = {}
    for row in edge_rows:
        for ip_key, zone_key in [("src_ip", "src_zone"), ("dst_ip", "dst_zone")]:
            ip = row[ip_key]
            zone = row[zone_key]
            if ip not in node_map:
                node_map[ip] = {"id": ip, "label": ip, "zone": zone, "parent": _zone_parent_id(zone),
                                "degree": 0, "bytes_total": 0}
            node_map[ip]["degree"] += 1
            node_map[ip]["bytes_total"] += row["bytes_total"]

    # Scale node sizes
    degrees = [n["degree"] for n in node_map.values()]
    mn, mx = min(degrees) if degrees else 0, max(degrees) if degrees else 0
    for n in node_map.values():
        n["size"] = round(_scale(n["degree"], mn, mx, 20, 60))

    zone_nodes = _build_zone_nodes()
    host_nodes = [{"data": n} for n in node_map.values()]
    nodes = zone_nodes + host_nodes

    edges = [{"data": {
        "id": f"{r['src_ip']}__{r['dst_ip']}",
        "source": r["src_ip"],
        "target": r["dst_ip"],
        **{k: r[k] for k in ("count", "bytes_total", "action", "protocol", "protocols",
                              "ports", "allow_count", "deny_count", "weight",
                              "policies", "policyids", "devices")},
    }} for r in edge_rows]

    return nodes, edges


def _ip_to_subnet(ip: str, mask: int) -> str:
    try:
        net = ipaddress.ip_network(f"{ip}/{mask}", strict=False)
        return str(net)
    except Exception:
        return ip


def aggregate_subnet(df: pd.DataFrame, mask: int = 24) -> tuple[list[dict], list[dict]]:
    if df.empty:
        return _build_zone_nodes(), []

    df = df.copy()
    df["src_subnet"] = df["src_ip"].apply(lambda ip: _ip_to_subnet(ip, mask))
    df["dst_subnet"] = df["dst_ip"].apply(lambda ip: _ip_to_subnet(ip, mask))

    grp = df.groupby(["src_subnet", "dst_subnet", "src_zone", "dst_zone"])
    edge_rows = []
    for (src_sub, dst_sub, src_zone, dst_zone), g in grp:
        count = len(g)
        bytes_total = int(g["bytes"].sum())
        dominant_action = _dominant(g["action"])
        dominant_protocol = _dominant(g["protocol"])
        protocols = sorted(g["protocol"].unique().tolist())
        ports = sorted(g["dst_port"].unique().tolist())
        allow_count = int((g["action"] == "allow").sum())
        deny_count = int((g["action"] == "deny").sum())
        weight = _scale(math.log1p(count), 0, math.log1p(df.shape[0]), 1, 8)
        edge_rows.append({
            "src_subnet": src_sub, "dst_subnet": dst_sub,
            "src_zone": src_zone, "dst_zone": dst_zone,
            "count": count, "bytes_total": bytes_total,
            "action": dominant_action, "protocol": dominant_protocol,
            "protocols": protocols, "ports": ports,
            "allow_count": allow_count, "deny_count": deny_count,
            "weight": round(weight, 2),
            **_policy_fields(g),
        })

    node_map: dict[str, dict] = {}
    for row in edge_rows:
        for sub_key, zone_key in [("src_subnet", "src_zone"), ("dst_subnet", "dst_zone")]:
            sub = row[sub_key]
            zone = row[zone_key]
            if sub not in node_map:
                node_map[sub] = {"id": sub, "label": sub, "zone": zone, "parent": _zone_parent_id(zone),
                                 "degree": 0, "bytes_total": 0, "shape": "roundrectangle"}
            node_map[sub]["degree"] += 1
            node_map[sub]["bytes_total"] += row["bytes_total"]

    degrees = [n["degree"] for n in node_map.values()]
    mn, mx = min(degrees) if degrees else 0, max(degrees) if degrees else 0
    for n in node_map.values():
        n["size"] = round(_scale(n["degree"], mn, mx, 30, 80))

    zone_nodes = _build_zone_nodes()
    subnet_nodes = [{"data": n} for n in node_map.values()]
    nodes = zone_nodes + subnet_nodes

    edges = [{"data": {
        "id": f"{r['src_subnet']}__{r['dst_subnet']}",
        "source": r["src_subnet"],
        "target": r["dst_subnet"],
        **{k: r[k] for k in ("count", "bytes_total", "action", "protocol", "protocols",
                              "ports", "allow_count", "deny_count", "weight",
                              "policies", "policyids", "devices")},
    }} for r in edge_rows]

    return nodes, edges


def aggregate_zone(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    known_zones = {"IT", "DMZ", "OT"}

    zone_nodes = []
    for z in known_zones:
        zone_nodes.append({"data": {
            "id": z,
            "label": z,
            "zone": z,
            "isZone": False,
            "size": 80,
        }})

    if df.empty:
        return zone_nodes, []

    grp = df.groupby(["src_zone", "dst_zone", "action"])
    edge_map: dict[tuple, dict] = {}
    for (src_zone, dst_zone, action), g in grp:
        key = (src_zone, dst_zone)
        count = len(g)
        if key not in edge_map:
            edge_map[key] = {
                "src_zone": src_zone, "dst_zone": dst_zone,
                "count": 0, "bytes_total": 0,
                "allow_count": 0, "deny_count": 0,
                "protocols": set(), "ports": set(),
                "policies": set(), "policyids": set(),
            }
        edge_map[key]["count"] += count
        edge_map[key]["bytes_total"] += int(g["bytes"].sum())
        if action == "allow":
            edge_map[key]["allow_count"] += count
        elif action == "deny":
            edge_map[key]["deny_count"] += count
        edge_map[key]["protocols"].update(g["protocol"].unique())
        edge_map[key]["ports"].update(g["dst_port"].unique())
        if "policyname" in g.columns:
            edge_map[key]["policies"].update(g["policyname"].dropna())
        if "policyid" in g.columns:
            edge_map[key]["policyids"].update(g["policyid"].dropna())

    all_counts = [e["count"] for e in edge_map.values()]
    mn, mx = (min(all_counts), max(all_counts)) if all_counts else (0, 0)

    edges = []
    for (src_zone, dst_zone), row in edge_map.items():
        dominant_action = "allow" if row["allow_count"] >= row["deny_count"] else "deny"
        weight = round(_scale(math.log1p(row["count"]), 0, math.log1p(mx or 1), 2, 14), 2)
        dominant_protocol = _dominant(df[
            (df["src_zone"] == src_zone) & (df["dst_zone"] == dst_zone)
        ]["protocol"])
        edges.append({"data": {
            "id": f"{src_zone}__{dst_zone}",
            "source": src_zone,
            "target": dst_zone,
            "count": row["count"],
            "bytes_total": row["bytes_total"],
            "action": dominant_action,
            "protocol": dominant_protocol,
            "protocols": sorted(row["protocols"]),
            "ports": sorted([int(p) for p in row["ports"] if str(p).isdigit()]),
            "allow_count": row["allow_count"],
            "deny_count": row["deny_count"],
            "weight": weight,
            "policies":  sorted([p for p in row["policies"]  if p and p != "nan"]),
            "policyids": sorted([p for p in row["policyids"] if p and p != "nan"]),
        }})

    return zone_nodes, edges
