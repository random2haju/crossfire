import io
import re
import pandas as pd
from fastapi import HTTPException

# ── Column alias map (CSV mode) ──────────────────────────────────────
COLUMN_ALIASES: dict[str, str] = {
    # src_ip
    "source_ip": "src_ip", "src_addr": "src_ip", "src_address": "src_ip",
    "sourceip": "src_ip", "source": "src_ip", "src": "src_ip",
    "client_ip": "src_ip", "orig_ip": "src_ip", "srcip": "src_ip",
    # dst_ip
    "destination_ip": "dst_ip", "dst_addr": "dst_ip", "dst_address": "dst_ip",
    "dest_ip": "dst_ip", "destinationip": "dst_ip", "destination": "dst_ip",
    "dst": "dst_ip", "server_ip": "dst_ip", "resp_ip": "dst_ip", "dstip": "dst_ip",
    # src_port
    "source_port": "src_port", "src_port_num": "src_port", "sport": "src_port",
    "sourceport": "src_port", "orig_port": "src_port", "srcport": "src_port",
    # dst_port
    "destination_port": "dst_port", "dst_port_num": "dst_port", "dport": "dst_port",
    "destinationport": "dst_port", "dest_port": "dst_port", "resp_port": "dst_port",
    "dstport": "dst_port",
    # protocol
    "proto": "protocol", "ip_protocol": "protocol", "transport": "protocol",
    # action
    "verdict": "action", "disposition": "action", "result": "action",
    "policy_action": "action", "fw_action": "action",
    # bytes
    "byte_count": "bytes", "total_bytes": "bytes", "bytes_total": "bytes",
    "traffic_bytes": "bytes", "bytes_sent": "bytes",
    "sentbyte": "bytes",   # FortiGate: use sent bytes as primary
    "rcvdbyte": "_rcvdbyte",  # FortiGate: kept separately, summed below
    # timestamp
    "time": "timestamp", "datetime": "timestamp", "date_time": "timestamp",
    "event_time": "timestamp", "log_time": "timestamp", "receive_time": "timestamp",
    # device_name
    "device": "device_name", "firewall": "device_name", "hostname": "device_name",
    "host": "device_name", "sensor": "device_name", "devname": "device_name",
    # src_zone
    "source_zone": "src_zone", "src_zone_name": "src_zone", "from_zone": "src_zone",
    "ingress_zone": "src_zone", "zone_src": "src_zone",
    "srcintfrole": "src_zone",   # FortiGate interface role
    "srcintf": "_srcintf",       # FortiGate interface name (kept as reference)
    # dst_zone
    "destination_zone": "dst_zone", "dst_zone_name": "dst_zone", "to_zone": "dst_zone",
    "egress_zone": "dst_zone", "zone_dst": "dst_zone",
    "dstintfrole": "dst_zone",   # FortiGate interface role
    "dstintf": "_dstintf",       # FortiGate interface name
}

# ── Protocol number → name ───────────────────────────────────────────
PROTO_NUMBERS: dict[str, str] = {
    "1":   "ICMP",
    "2":   "IGMP",
    "6":   "TCP",
    "17":  "UDP",
    "41":  "IPv6",
    "47":  "GRE",
    "50":  "ESP",
    "51":  "AH",
    "58":  "ICMPv6",
    "89":  "OSPF",
    "132": "SCTP",
}

# ── Zone normalization ───────────────────────────────────────────────
IT_PATTERNS  = {"it", "inside", "lan", "corp", "corporate", "internal", "trusted",
                "user", "users", "mgmt", "management", "employee"}
DMZ_PATTERNS = {"dmz", "perimeter", "semi-trusted", "semi_trusted", "semitrusted",
                "extranet", "servers", "server"}
OT_PATTERNS  = {"ot", "ics", "scada", "industrial", "control", "operational",
                "plant", "field", "process", "plc", "hmi"}
WAN_PATTERNS = {"wan", "internet", "external", "untrusted", "outside", "uplink"}


def normalize_zone(raw: str) -> str:
    v = str(raw).strip().lower().replace("-", "").replace("_", "")
    raw_stripped = str(raw).strip()
    if v in IT_PATTERNS  or any(p.replace("-","").replace("_","") in v for p in IT_PATTERNS):
        return "IT"
    if v in DMZ_PATTERNS or any(p.replace("-","").replace("_","") in v for p in DMZ_PATTERNS):
        return "DMZ"
    if v in OT_PATTERNS  or any(p.replace("-","").replace("_","") in v for p in OT_PATTERNS):
        return "OT"
    if v in WAN_PATTERNS or any(p.replace("-","").replace("_","") in v for p in WAN_PATTERNS):
        return "WAN"
    return raw_stripped.upper() if raw_stripped else "UNKNOWN"


def normalize_action(raw: str) -> str:
    v = str(raw).strip().lower()
    # FortiGate-specific
    if v in {"accept", "allow", "allowed", "permit", "permitted", "pass", "ip-conn"}:
        return "allow"
    if v in {"deny", "denied", "block", "blocked", "reject", "rejected"}:
        return "deny"
    if v in {"drop", "dropped", "reset", "close", "client-rst", "server-rst",
             "reset-both", "reset-client", "reset-server", "timeout"}:
        return "drop"
    return v


def normalize_protocol(raw: str) -> str:
    v = str(raw).strip()
    # Numeric protocol → name
    if v in PROTO_NUMBERS:
        return PROTO_NUMBERS[v]
    return v.upper()


# ── FortiGate key=value parser ───────────────────────────────────────
# Handles: key=value key="quoted value" key=value pairs on each line.
_KV_RE = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|[^ ]+)')


def _parse_kv_line(line: str) -> dict[str, str]:
    record = {}
    for key, val in _KV_RE.findall(line):
        record[key.lower()] = val.strip('"')
    return record


def _parse_fortigate_kv(content: bytes) -> pd.DataFrame:
    text = content.decode("utf-8", errors="replace")
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    rows = []
    for line in lines:
        # Skip comment lines or empty
        if line.startswith("#") or not line:
            continue
        rec = _parse_kv_line(line)
        if not rec:
            continue
        # Only keep traffic logs (type=traffic)
        if rec.get("type", "traffic") not in ("traffic", ""):
            continue
        rows.append(rec)

    if not rows:
        raise HTTPException(status_code=400, detail="No traffic log records found in FortiGate log file")

    df = pd.DataFrame(rows)
    df.columns = [c.strip().lower() for c in df.columns]

    # Merge date + time into timestamp if no single timestamp column
    if "timestamp" not in df.columns and "date" in df.columns and "time" in df.columns:
        df["timestamp"] = df["date"] + " " + df["time"]
    elif "eventtime" in df.columns and "timestamp" not in df.columns:
        # eventtime is unix epoch in FortiGate
        df["timestamp"] = pd.to_datetime(
            pd.to_numeric(df["eventtime"], errors="coerce"), unit="s", utc=True
        ).dt.tz_localize(None)

    # Sum sentbyte + rcvdbyte for total bytes if both present
    if "sentbyte" in df.columns and "rcvdbyte" in df.columns:
        df["bytes"] = (
            pd.to_numeric(df["sentbyte"], errors="coerce").fillna(0) +
            pd.to_numeric(df["rcvdbyte"], errors="coerce").fillna(0)
        ).astype(int)
    elif "sentbyte" in df.columns:
        df["bytes"] = pd.to_numeric(df["sentbyte"], errors="coerce").fillna(0).astype(int)

    # Zone: prefer srcintfrole/dstintfrole; fall back to srcintf/dstintf
    for role_col, intf_col, out_col in [
        ("srcintfrole", "srcintf", "src_zone"),
        ("dstintfrole", "dstintf", "dst_zone"),
    ]:
        if role_col in df.columns:
            df[out_col] = df[role_col]
        elif intf_col in df.columns:
            df[out_col] = df[intf_col]
        elif out_col not in df.columns:
            df[out_col] = "UNKNOWN"

    # Rename canonical fields
    rename = {
        "srcip": "src_ip", "dstip": "dst_ip",
        "srcport": "src_port", "dstport": "dst_port",
        "proto": "protocol", "devname": "device_name",
    }
    df.rename(columns={k: v for k, v in rename.items() if k in df.columns}, inplace=True)

    return df


# ── Format auto-detection ────────────────────────────────────────────
def _is_fortigate_kv(content: bytes) -> bool:
    # Check first non-empty line for key=value pattern
    try:
        head = content[:2048].decode("utf-8", errors="replace")
    except Exception:
        return False
    for line in head.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # FortiGate lines always start with date= or devname= or logid=
        if re.match(r'^(date|devname|logid|eventtime)=', line):
            return True
        # Generic: if >5 key=value pairs and no comma separation → likely kv
        kv_count = len(_KV_RE.findall(line))
        comma_count = line.count(",")
        if kv_count > 5 and comma_count < kv_count // 2:
            return True
        break
    return False


# ── Main entry point ─────────────────────────────────────────────────
def parse_csv(content: bytes) -> pd.DataFrame:
    if _is_fortigate_kv(content):
        df = _parse_fortigate_kv(content)
    else:
        try:
            df = pd.read_csv(io.BytesIO(content), dtype=str, na_filter=False)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"CSV parse error: {e}")

        df.columns = [c.strip().lower() for c in df.columns]
        df.rename(columns=COLUMN_ALIASES, inplace=True)

    # ── From here, normalization is shared ──────────────────────────

    for required in ("src_ip", "dst_ip"):
        if required not in df.columns:
            raise HTTPException(status_code=400, detail=f"Missing required column: {required}")

    df["src_ip"] = df["src_ip"].astype(str).str.strip()
    df["dst_ip"] = df["dst_ip"].astype(str).str.strip()
    df = df[df["src_ip"].ne("") & df["dst_ip"].ne("") &
            df["src_ip"].ne("nan") & df["dst_ip"].ne("nan")]

    if df.empty:
        raise HTTPException(status_code=400, detail="No valid rows after parsing")

    # Timestamp
    if "timestamp" in df.columns and not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    elif "timestamp" not in df.columns:
        df["timestamp"] = pd.NaT

    # Numeric columns
    for col in ("src_port", "dst_port", "bytes"):
        if col not in df.columns:
            df[col] = 0
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)

    # String columns
    for col in ("protocol", "action", "device_name"):
        if col not in df.columns:
            df[col] = "unknown"
        df[col] = df[col].fillna("unknown").astype(str).str.strip()

    # Zone columns
    for col in ("src_zone", "dst_zone"):
        if col not in df.columns:
            df[col] = "UNKNOWN"
        df[col] = df[col].astype(str).apply(normalize_zone)

    df["action"]   = df["action"].apply(normalize_action)
    df["protocol"] = df["protocol"].apply(normalize_protocol)

    # Use FortiGate "service" field as protocol when it's meaningful
    # e.g. service=SMB is more useful than protocol=TCP
    if "service" in df.columns:
        df["service"] = df["service"].astype(str).str.strip().str.upper()
        _ignore = {"ALL", "ALL_ICMP", "ALL_TCP", "ALL_UDP", "", "UNKNOWN", "N/A", "NONE"}
        mask = ~df["service"].isin(_ignore)
        df.loc[mask, "protocol"] = df.loc[mask, "service"]
        df.drop(columns=["service"], inplace=True)

    # Normalize policyname / policyid as plain strings
    for col in ("policyname", "policyid"):
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()
        else:
            df[col] = ""

    # Drop internal helper columns
    df.drop(columns=[c for c in df.columns if c.startswith("_")], inplace=True, errors="ignore")

    return df.reset_index(drop=True)
