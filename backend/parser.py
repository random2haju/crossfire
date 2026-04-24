import io
import logging
import re
import pandas as pd
from fastapi import HTTPException

log = logging.getLogger("crossfire")

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

    # Merge date + time into timestamp (FortiGate time= field may embed tz offset)
    if "timestamp" not in df.columns and "date" in df.columns and "time" in df.columns:
        raw = df["date"] + " " + df["time"]
        parsed = pd.to_datetime(raw, errors="coerce", utc=False)
        df["timestamp"] = _force_tz_naive(parsed)
    elif "eventtime" in df.columns and "timestamp" not in df.columns:
        parsed = pd.to_datetime(
            pd.to_numeric(df["eventtime"], errors="coerce"), unit="s", utc=True
        )
        df["timestamp"] = _force_tz_naive(parsed)

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


def _force_tz_naive(series: pd.Series) -> pd.Series:
    """Convert any datetime series to tz-naive UTC. Works regardless of input tz state."""
    if series.empty:
        return series
    try:
        if isinstance(series.dtype, pd.DatetimeTZDtype):
            return series.dt.tz_convert("UTC").dt.tz_localize(None)
        return series
    except Exception:
        # Last resort: re-parse as strings, coerce tz via utc=True, then strip
        try:
            return pd.to_datetime(series.astype(str), errors="coerce", utc=True).dt.tz_localize(None)
        except Exception:
            return series


# ── BOM stripping ────────────────────────────────────────────────────
def _strip_bom(content: bytes) -> bytes:
    for bom, enc in [
        (b'\xef\xbb\xbf', 'utf-8'),   # UTF-8 BOM
        (b'\xff\xfe', 'utf-16'),        # UTF-16 LE
        (b'\xfe\xff', 'utf-16'),        # UTF-16 BE
    ]:
        if content.startswith(bom):
            if enc == 'utf-8':
                return content[len(bom):]
            return content.decode(enc, errors='replace').encode('utf-8')
    return content


# ── Format auto-detection ────────────────────────────────────────────
def _is_fortigate_kv(content: bytes) -> bool:
    """Return True if the file looks like FortiGate space-separated key=value logs."""
    try:
        head = content[:8192].decode("utf-8", errors="replace")
    except Exception:
        return False

    kv_lines = 0
    for line in head.splitlines()[:30]:   # inspect up to 30 lines
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Definitive FortiGate markers
        if re.match(r'^(date|devname|logid|eventtime|type)=', line):
            return True
        kv_count = len(_KV_RE.findall(line))
        comma_count = line.count(",")
        # A kv line has many key=value pairs and few bare commas
        if kv_count >= 5 and comma_count < kv_count // 2:
            kv_lines += 1
            if kv_lines >= 2:
                return True

    return False


def _try_csv(content: bytes) -> "pd.DataFrame | None":
    """Try to parse as CSV with comma, semicolon, or tab separator. Skip bad lines."""
    for sep in (',', ';', '\t'):
        try:
            df = pd.read_csv(
                io.BytesIO(content),
                dtype=str,
                na_filter=False,
                sep=sep,
                on_bad_lines='skip',
                engine='python',      # python engine is more tolerant
            )
            if len(df.columns) > 1:   # at least 2 columns = looks like real CSV
                return df
        except Exception:
            continue
    return None


# ── Main entry point ─────────────────────────────────────────────────
def parse_csv(content: bytes) -> pd.DataFrame:
    content = _strip_bom(content)

    is_kv = _is_fortigate_kv(content)
    log.info(f"Format detection: {'FortiGate kv' if is_kv else 'CSV/unknown'}")

    df = None
    parse_error = None

    if is_kv:
        log.info("Parsing as FortiGate kv")
        df = _parse_fortigate_kv(content)
    else:
        log.info("Trying CSV parser (comma / semicolon / tab)")
        df = _try_csv(content)
        if df is not None:
            log.info(f"CSV parsed OK: {len(df)} rows, {len(df.columns)} cols, sep detected")
            df.columns = [c.strip().lower() for c in df.columns]
            df.rename(columns=COLUMN_ALIASES, inplace=True)
        else:
            log.warning("CSV failed — trying FortiGate kv as fallback")
            try:
                df = _parse_fortigate_kv(content)
                log.info(f"kv fallback OK: {len(df)} rows")
            except Exception as e:
                import traceback
                parse_error = traceback.format_exc()
                log.error(f"kv fallback failed: {parse_error}")

    if df is None:
        raise HTTPException(
            status_code=400,
            detail=f"Could not parse file as CSV or FortiGate log. {parse_error or ''}"
        )

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

    # Timestamp — parse then always force tz-naive so files can be merged
    if "timestamp" not in df.columns:
        df["timestamp"] = pd.NaT
    elif not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df["timestamp"] = _force_tz_naive(df["timestamp"])

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
