from pydantic import BaseModel
from typing import Optional, List, Dict, Any


class FilterParams(BaseModel):
    mode: str = "host"
    subnet_mask: int = 24
    time_start: Optional[str] = None
    time_end: Optional[str] = None
    src_zone: Optional[str] = None
    dst_zone: Optional[str] = None
    src_ip: Optional[str] = None
    dst_ip: Optional[str] = None
    protocol: Optional[str] = None
    dst_port: Optional[int] = None
    action: Optional[str] = None
    device_name: Optional[str] = None
    cross_zone_only: bool = False


class NodeData(BaseModel):
    id: str
    label: str
    zone: str
    parent: Optional[str] = None
    size: float = 30
    degree: int = 0
    bytes_total: int = 0


class EdgeData(BaseModel):
    id: str
    source: str
    target: str
    count: int
    bytes_total: int
    action: str
    protocol: str
    protocols: List[str]
    ports: List[int]
    allow_count: int = 0
    deny_count: int = 0
    weight: float = 1.0
    flags: List[str] = []


class GraphResponse(BaseModel):
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
    record_count: int
    time_min: Optional[str] = None
    time_max: Optional[str] = None


class SummaryResponse(BaseModel):
    top_edges: List[Dict[str, Any]]
    top_denied: List[Dict[str, Any]]
    top_dst_ports: List[Dict[str, Any]]
    cross_zone_totals: Dict[str, int]
    new_paths: List[Dict[str, Any]]
    top_talkers: List[Dict[str, Any]]
    record_count: int
