# Margin - Privacy Policy

Last updated: 4 October 2026

Margin is a browser extension for highlighting and annotating PDFs and web pages, translating
the words you choose, and reviewing them as flashcards. This page explains what the extension
does with your data.

## Summary

- Margin has no account, no server of its own, no analytics, no advertising and no tracking.
- Everything you create stays in your own browser, on your own computer.
- Data leaves your computer only when you ask for one of the three online lookups described
  below, and only the few words needed for that lookup are sent.
- Nothing is sold, and nothing is shared with anyone for any other purpose.

## What Margin stores, and where

Margin stores the following in your browser's local extension storage on your device:

- your highlights, pen marks and notes, with the title and address of the document they belong to;
- the words you save to your vocabulary, with their translation and the sentence they came from;
- your settings (colors, languages, appearance) and the page where you stopped reading each PDF;
- the text recognized on scanned PDF pages, so they do not have to be read again.

The developer cannot see any of this. It is removed when you remove the extension.

Text recognition (OCR) of scanned pages runs entirely on your device. No page images or
recognized text are sent anywhere.

## When data leaves your device

Only in these three cases, and each one starts with an action of yours:

| When you... | What is sent | To whom |
|---|---|---|
| click **Translate** on a selection | the selected text, and the two language codes | Google Translate (translate.googleapis.com); if it does not answer, MyMemory (api.mymemory.translated.net) |
| translate a single word or short phrase | that word or phrase, to fetch its dictionary definition | Free Dictionary API (api.dictionaryapi.dev) |
| open the **Cite** panel of a PDF, or click "Look up again" | the document's title, first author's family name and DOI, if it has one | Crossref (api.crossref.org) |

These requests carry no account, no identifier and no cookies from Margin. As with any web
request, the receiving service sees your IP address; its own privacy policy applies to that.

Margin does not read, collect or send the pages you visit. On web pages it only looks at text
that you select and choose to highlight or translate.

## Files Margin writes on your device

- **Backup**: a copy of your Margin data is saved to `Downloads/Margin backups` on your own
  computer, so that it survives a browser reset. You can turn this off in Settings.
- **Sync (optional, off by default)**: if you choose a folder in Settings, Margin keeps one file
  there (`margin-sync.json`). If that folder belongs to a cloud drive such as OneDrive or Google
  Drive, that service copies the file between your computers under its own terms. Margin itself
  sends nothing.
- **Exports**: Word, Markdown and PDF files that you ask Margin to create are saved to your
  Downloads folder.

## Permissions, and why Margin asks for them

- **Access to all websites**: to open any PDF link in the Margin reader, and to let you highlight
  and translate text on any web page. Margin does nothing on a page until you select text.
- **Storage / unlimited storage**: to keep your highlights, notes, vocabulary and recognized text.
- **Downloads**: to save backups and the files you export.
- **Context menus**: for the right-click items "Translate with Margin", "Highlight selection" and
  "Open link in Margin PDF reader".
- **Alarms**: to run the scheduled backup and to update the count of flashcards due.

## Children

Margin is a general study tool and does not knowingly collect any personal information from
anyone, including children.

## Changes

If Margin's handling of data ever changes, this page will be updated and the change will be
announced inside the extension before it takes effect.

## Contact

Questions about this policy: open an issue in this repository, or write to
thinh.nguyen.140107@gmail.com.
