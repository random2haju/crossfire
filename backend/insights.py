import pandas as pd


def compute_summary(df: pd.DataFrame) -> dict:
    if df is None or df.empty:
        return {
            "top_edges": [], "top_denied": [], "top_dst_ports": [],
            "cross_zone_totals": {}, "new_paths": [], "top_talkers": [],
            "record_count": 0,
        }

    record_count = len(df)

    # Top 10 edges by event count
    top_edges = (
        df.groupby(["src_ip", "dst_ip"])
        .size()
        .reset_index(name="count")
        .sort_values("count", ascending=False)
        .head(10)
        .to_dict(orient="records")
    )

    # Top 10 denied flows
    denied = df[df["action"] == "deny"]
    top_denied = (
        denied.groupby(["src_ip", "dst_ip", "dst_port", "protocol"])
        .size()
        .reset_index(name="count")
        .sort_values("count", ascending=False)
        .head(10)
        .to_dict(orient="records")
    )

    # Top 10 destination ports
    top_dst_ports = (
        df.groupby(["dst_port", "protocol"])
        .size()
        .reset_index(name="count")
        .sort_values("count", ascending=False)
        .head(10)
        .to_dict(orient="records")
    )

    # Cross-zone communication totals
    pairs = [
        ("IT", "DMZ"), ("DMZ", "OT"), ("OT", "DMZ"), ("DMZ", "IT"),
        ("IT", "OT"), ("OT", "IT"),
    ]
    cross_zone_totals = {}
    for src, dst in pairs:
        key = f"{src}→{dst}"
        cross_zone_totals[key] = int(
            ((df["src_zone"] == src) & (df["dst_zone"] == dst)).sum()
        )

    # New paths: flows first seen in the latter half of the dataset timeline
    new_paths = []
    if df["timestamp"].notna().any():
        ts_valid = df[df["timestamp"].notna()].copy()
        sorted_ts = ts_valid["timestamp"].sort_values().reset_index(drop=True)
        median_ts = sorted_ts.iloc[len(sorted_ts) // 2]
        late_df = ts_valid[ts_valid["timestamp"] > median_ts]
        early_df = ts_valid[ts_valid["timestamp"] <= median_ts]
        early_paths = set(zip(early_df["src_ip"], early_df["dst_ip"]))
        late_paths = late_df.groupby(["src_ip", "dst_ip"]).size().reset_index(name="count")
        new_paths_df = late_paths[
            ~late_paths.apply(lambda r: (r["src_ip"], r["dst_ip"]) in early_paths, axis=1)
        ]
        new_paths = new_paths_df.sort_values("count", ascending=False).head(10).to_dict(orient="records")

    # Top 10 talkers by total bytes
    top_talkers = (
        df.groupby("src_ip")["bytes"]
        .sum()
        .reset_index(name="total_bytes")
        .sort_values("total_bytes", ascending=False)
        .head(10)
        .astype({"total_bytes": int})
        .to_dict(orient="records")
    )

    return {
        "top_edges": top_edges,
        "top_denied": top_denied,
        "top_dst_ports": top_dst_ports,
        "cross_zone_totals": cross_zone_totals,
        "new_paths": new_paths,
        "top_talkers": top_talkers,
        "record_count": record_count,
    }
