import hashlib
import zipfile
from pathlib import Path


workspace = Path(r"C:\Users\user\Documents\New project")
manual = workspace / "Tarangini Billing 2.3.0 Visual User Manual.docx"
old_image = workspace / "tarangini billing - brave" / "output" / "manual-render-final" / "desktop-stock-old.png"
new_image = workspace / "tarangini billing - brave" / "output" / "responsive-chrome" / "desktop-stock.png"
temporary = manual.with_suffix(".updated.docx")

old_hash = hashlib.sha256(old_image.read_bytes()).hexdigest()
replacement = new_image.read_bytes()
matches = 0

with zipfile.ZipFile(manual, "r") as source, zipfile.ZipFile(temporary, "w") as target:
    for item in source.infolist():
        content = source.read(item.filename)
        if item.filename.startswith("word/media/") and hashlib.sha256(content).hexdigest() == old_hash:
            content = replacement
            matches += 1
        target.writestr(item, content)

if matches != 1:
    temporary.unlink(missing_ok=True)
    raise RuntimeError(f"Expected one stock screenshot in the manual, found {matches}")

temporary.replace(manual)
