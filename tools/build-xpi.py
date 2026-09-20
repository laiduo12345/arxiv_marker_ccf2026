"""Build a clean, reproducible Zotero XPI.

The archive is a standard ZIP with ``manifest.json`` at the root. Runtime files are sorted,
all entry paths use forward slashes, and timestamps/permissions are normalized so rebuilding
from the source archive produces byte-identical output.

Run from the repository root::

    python tools/build-xpi.py
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
manifest = json.loads((PLUGIN_DIR / "manifest.json").read_text(encoding="utf-8"))
settings = manifest.get("applications", {}).get("zotero", {})
for field in ("id", "strict_min_version", "strict_max_version"):
    if not settings.get(field):
        raise ValueError(f"Missing required applications.zotero.{field}")
if manifest.get("browser_specific_settings", {}).get("zotero") != settings:
    raise ValueError("The two Zotero manifest settings must agree")
for name in ("bootstrap.js", "content/scripts/network.js", "content/scripts/discovery.js",
             "content/scripts/pipeline.js", "content/scripts/zotero-http.js",
             "content/scripts/arxiv_marker_ccf2026.js"):
    if not (PLUGIN_DIR / name).is_file():
        raise ValueError(f"Missing runtime module: {name}")
version = manifest["version"]
build_dir = PLUGIN_DIR / "build"
build_dir.mkdir(exist_ok=True)
xpi = build_dir / f"arxiv_marker_ccf2026-{version}.xpi"
if xpi.exists():
    xpi.unlink()

# Runtime files only: top-level entry points plus everything under content/.
files: list[tuple[Path, str]] = []
for top in ("manifest.json", "bootstrap.js", "prefs.js"):
    path = PLUGIN_DIR / top
    if path.exists():
        files.append((path, top))
for path in sorted((PLUGIN_DIR / "content").rglob("*")):
    if path.is_file():
        files.append((path, path.relative_to(PLUGIN_DIR).as_posix()))
files.sort(key=lambda item: item[1])

# ZIP's earliest representable timestamp. Normalizing it avoids source-extraction mtimes
# changing the XPI hash. 0644 regular-file mode keeps the archive portable.
fixed_time = (1980, 1, 1, 0, 0, 0)
with zipfile.ZipFile(xpi, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path, entry in files:
        info = zipfile.ZipInfo(entry, date_time=fixed_time)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o100644 & 0xFFFF) << 16
        info.flag_bits |= 0x800  # UTF-8 filename flag
        archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

print(f"built: {xpi}")
with zipfile.ZipFile(xpi) as archive:
    for name in archive.namelist():
        print(f"  {name}")
