#!/usr/bin/env python3
"""Builds the Chrome Web Store package from the margin/ folder.

Usage:  python tools/build_store.py            (run from the repository root)
Result: store/margin-store-<version>.zip       (manifest.json at the top level, as the store requires)

The store package differs from the folder install in one way only: the self-update code
(which reloads the extension when the files in its folder change) is taken out, because
the browser updates store extensions itself.
"""
import json, re, shutil, sys, zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = root / 'margin'
out_dir = root / 'store'
work = out_dir / '_build'

if work.exists():
    shutil.rmtree(work)
shutil.copytree(src, work)

# 1. folder-only code in the background script
bg = work / 'background.js'
text = bg.read_text(encoding='utf-8')
text, n = re.subn(r'[ \t]*/\* dev-only:start \*/.*?/\* dev-only:end \*/[ \t]*\n', '', text, flags=re.S)
if n == 0 or 'dev-only' in text or 'checkForUpdate' in text or 'runtime.reload' in text:
    sys.exit('background.js: folder-only blocks were not removed cleanly')
bg.write_text(text, encoding='utf-8')

# 2. the "update ready" button on Margin's pages
(work / 'common' / 'update.js').unlink()
for page in work.rglob('*.html'):
    html = page.read_text(encoding='utf-8')
    cleaned = re.sub(r'[ \t]*<script src="[^"]*common/update\.js"></script>\n?', '', html)
    if cleaned != html:
        page.write_text(cleaned, encoding='utf-8')
if any('update.js' in p.read_text(encoding='utf-8', errors='ignore') for p in work.rglob('*.html')):
    sys.exit('a page still refers to update.js')

# 3. files that only make sense for the folder install
(work / 'README.txt').unlink(missing_ok=True)

version = json.loads((work / 'manifest.json').read_text(encoding='utf-8'))['version']
target = out_dir / f'margin-store-{version}.zip'
target.unlink(missing_ok=True)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in sorted(work.rglob('*')):
        if f.is_file():
            z.write(f, f.relative_to(work).as_posix())
shutil.rmtree(work)
print(f'{target.relative_to(root)}  ({target.stat().st_size / 1048576:.1f} MB)')
