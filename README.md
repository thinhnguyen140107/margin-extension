# Margin

A browser extension for reading seriously: highlight and annotate PDFs and web pages, translate
only the words you choose, and review them as flashcards. Works in Chrome, Edge and Brave.

## What it does

- **PDF reader on the PDF's own address.** Select text to highlight it in one of four named
  colors (main idea, evidence, quote, question), add a note, or look up just that word: its
  English definition first, the translation one click away.
- **Scanned PDFs.** Pages without selectable text are read on your computer (OCR, English and
  Vietnamese), and a pen and highlighter mark anything by hand.
- **Vocabulary.** Saved words become flashcards with spaced review: word to meaning, meaning to
  word, or typing. They can be exported for Anki.
- **Citations.** Finds the published record on Crossref and formats it in APA, MLA, Chicago,
  Harvard or BibTeX; "Copy quote" adds the page reference.
- **Export.** Notes as Word or Markdown, or a copy of the PDF with your highlights inside it.
- **Web pages, if you want.** Off by default; switch it on in Settings to highlight and take notes
  on ordinary pages as well.
- **Yours.** No account and no server. Automatic backup to your Downloads folder, optional sync
  through a folder of your own cloud drive. See [PRIVACY.md](PRIVACY.md).

## Keyboard

With text selected in the reader: `1` `2` `3` `4` highlight in that color, `T` looks the word up,
`N` adds a note. `Ctrl` + scroll (or `Ctrl` + plus / minus) zooms at the pointer, `Ctrl` + `F` searches.

## Your data

Everything is kept in the browser profile. Two copies can exist outside it, and both are plain,
unencrypted files that anyone with access to the computer or the cloud folder can read:

- the automatic backup in `Downloads/Margin backups` (can be turned off in Settings);
- `margin-sync.json` in the sync folder, if you set one up.

## Install

**From the Chrome Web Store** (recommended, updates itself): link to be added once published.

**From this repository** (for development):

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose the
   `margin` folder.
3. In Margin's details, turn on "Allow access to file URLs" to read PDFs stored on your computer.

## Repository layout

| Path | What it is |
|---|---|
| `margin/` | The extension itself (Manifest V3, plain JavaScript, no build step) |
| `tools/build_store.py` | Makes the Chrome Web Store package in `store/` |
| `store/` | Store listing text, screenshots and the packaged zip |
| `PRIVACY.md` | Privacy policy |

To make a store package: `python tools/build_store.py`, then upload
`store/margin-store-<version>.zip` in the Chrome Web Store developer dashboard.

## Third-party components

Bundled unmodified, each under its own license:

- [PDF.js](https://github.com/mozilla/pdf.js) 4.10.38 - Apache License 2.0
- [Tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 and its language data - Apache License 2.0
- [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 - MIT License

Online lookups, used only when you ask for them: Google Translate, MyMemory, Wiktionary, Free
Dictionary API, Crossref.
