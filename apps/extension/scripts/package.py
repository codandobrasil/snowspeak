"""Gera o .zip da extensão para a Chrome Web Store a partir de dist/ (rode depois do build)."""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
dist = root / "dist"
version = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / f"snowspeak-{version}.zip"

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    # O manifest.json precisa ficar na raiz do zip.
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(dist).as_posix())

print(out)
