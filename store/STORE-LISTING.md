# Chrome Web Store - what to paste where

Everything below is ready to copy into the developer dashboard
(https://chrome.google.com/webstore/devconsole). Fields not mentioned can stay as they are.

## 0. Before you start

1. Put this folder on GitHub first (see "GitHub" at the end): the store asks for a link to the
   privacy policy, and that link is the PRIVACY.md page of the repository.
2. In the dashboard, open **Settings** (left side): fill in the publisher name and verify the
   contact email. Publishing is blocked until the email is verified.

## 1. Upload

**Items > New item** > choose `margin-store-1.15.2.zip` from this folder.

## 2. Store listing tab

**Title** (comes from the package): Margin - PDF Highlighter, Notes & Vocabulary

**Summary** (comes from the package): Highlight and annotate PDFs and web pages, translate only
the words you choose, and review them as flashcards.

**Description**

```
Margin turns your browser into a place for serious reading.

Open any PDF and it opens in the Margin reader, on the PDF's own address. Select a passage to highlight it, add a note, or look up just the one word that is in your way - not the whole page. The words you save come back as flashcards, so the vocabulary you meet while reading is vocabulary you keep.

HIGHLIGHT WITH A PURPOSE
- Four colors, each with a meaning you can rename: main idea, evidence, quote to cite, question.
- Your notes panel groups every highlight by what its color means.
- Extra colors can be added for a single document.
- Keyboard: select text, then press 1 to 4 for a color, N for a note.
- Optional: switch Margin on for ordinary web pages too (off by default).

SCANNED PDFS
- Pages that are only images are read on your own computer (English and Vietnamese), so their text can be selected, highlighted, searched and translated.
- A pen and a highlighter mark anything by hand.

LEARN THE WORD, NOT JUST ITS TRANSLATION
- Double-click a word and press T: you get its English definition and the sentence it came from. The translation into your language is one click away, so you think in the language you are reading.
- Prefer translations first? Change it in Settings, along with your language.
- Save the word, then review it later: word to meaning, meaning to word, or by typing it. Review is spaced, so words you know well come back less often.
- Export your words for Anki.

CITE AND EXPORT
- Finds the published record of an article and formats the citation in APA, MLA, Chicago, Harvard or BibTeX.
- "Copy quote" copies a passage together with its page reference.
- Export your notes as a Word or Markdown file, or as a copy of the PDF with your highlights inside it.

COMFORTABLE TO READ IN
- Light, dark and night modes. Light and dark never change the document's own colors.
- Reopens every PDF where you stopped.
- Zoom follows the pointer; thumbnails, outline and search are one click away.

PRIVATE BY DESIGN
- No account, no server, no tracking, no ads.
- Everything is stored in your own browser, with an automatic backup to your Downloads folder.
- Text leaves your computer only when you ask: the words you choose to look up go to a dictionary and a translation service, and opening the Cite panel looks the document up on Crossref.
- Optional sync between your own computers through a folder of your cloud drive.

To read PDFs stored on your computer, turn on "Allow access to file URLs" in the extension's details.
```

**Category**: Education

**Language**: English

**Store icon**: `icon-128.png` (in this folder)

**Screenshots** (1280x800, upload in this order): `screenshot-1.png` ... `screenshot-5.png`

**Small promo tile** (440x280): `promo-440x280.png`

**Homepage URL / Support URL**: the address of your GitHub repository (support: its `/issues` page)

## 3. Privacy practices tab

**Single purpose**

```
Margin is a reading tool. It lets the user highlight and annotate PDFs and web pages, translate the words they select, and review those words as flashcards.
```

**Permission justifications**

storage
```
Stores the user's highlights, notes, saved vocabulary and settings locally in the browser.
```

unlimitedStorage
```
Text recognized on scanned PDF pages (OCR, done on the device) is cached locally so pages do not have to be recognized again. For long scanned books this cache, together with highlights and notes, can exceed the default storage quota.
```

contextMenus
```
Adds the right-click item "Open link in Margin PDF reader" for links and, when the user has switched Margin on for web pages, "Translate with Margin" and "Highlight selection" for selected text.
```

alarms
```
Runs the periodic local backup of the user's notes to the Downloads folder and refreshes the toolbar badge showing how many flashcards are due.
```

downloads
```
Saves files the user asks for (notes exported as Word or Markdown, a PDF copy with highlights) and the automatic local backup file in "Downloads/Margin backups".
```

Host permission (all sites) and content scripts
```
Margin works on any address the user reads: (1) a PDF at any URL is opened in Margin's reader, which needs to detect PDF documents and fetch the file from its own address; (2) if the user switches the option on (it is off by default), they can highlight, annotate and translate selected text on any web page, and their saved highlights are redrawn when the page is visited again. With the option off the content script does nothing on web pages. No page content is collected or transmitted, except the text the user explicitly selects and asks to look up.
```

**Are you using remote code?** No, I am not using remote code.
(All scripts, including PDF.js, Tesseract.js and pdf-lib, are inside the package.)

**Data usage - what user data do you collect?** Tick only: **Website content**.
(Reason: text the user selects and chooses to translate is sent to a translation service. Nothing
else on the list applies.)

**Certifications**: tick all three (no selling of data, no use for unrelated purposes, no use for
creditworthiness or lending).

**Privacy policy URL**: `https://github.com/<your-username>/<repository>/blob/main/PRIVACY.md`

## 4. Distribution tab

- **Payments**: Free of charge.
- **Visibility**: start with **Unlisted** (only people with the link can find it - right for
  sharing with friends). Change it to Public later whenever you want; nothing has to be re-uploaded.
- **Regions**: All regions.

## 5. Test instructions tab (for the reviewer)

```
No account or login is needed.
1. Open any PDF link, for example https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf - it opens in the Margin reader on the same address.
2. Select text: a small toolbar offers four highlight colors, Note and Translate.
3. Translate (or the T key) sends only the selected text to Wiktionary for a definition and to Google Translate (fallback: MyMemory) for a translation; "Save to vocabulary" stores it locally.
4. The toolbar icon opens the dashboard: library of highlights, vocabulary flashcards, settings.
5. Web pages are off by default. After switching on "Use Margin on web pages too" in Settings, select text on any page to highlight it; the highlight is restored on the next visit.
Bundled third-party libraries (unmodified, minified by their authors): PDF.js 4.10.38, Tesseract.js 5.1.1 (OCR runs locally in WebAssembly, which is why the manifest CSP contains 'wasm-unsafe-eval'), pdf-lib 1.17.1.
```

## 6. Submit

Click **Submit for review**. Because Margin asks for access to all sites, expect the review to
take longer than for a simple extension. You get an email when it is approved or if a change is
requested.

## After it is approved

- Send friends the store link. Their copy updates itself from then on.
- On your own computer: in the folder version, go to Dashboard > Settings > Backup and save a
  backup; install the store version; import that backup there; then remove the folder version.
  (The store version is a separate installation with its own, empty storage, and two Margins at
  once would both try to open PDFs.)

## Publishing an update later

1. Raise `"version"` in `margin/manifest.json`.
2. Run `python tools/build_store.py`.
3. Dashboard > Margin > Package > Upload new package > Submit for review.

## GitHub

1. Install GitHub Desktop and sign in.
2. File > Add local repository > choose this `margin-extension` folder > "create a repository".
3. Publish repository (untick "Keep this code private" - the privacy policy link must be public).
4. Open the repository on github.com, click PRIVACY.md, and copy that page's address into the
   store's privacy policy field.

## Updating the listing for version 1.15.2

Do this only after the first submission has been approved (uploading a new package while a review
is pending restarts the wait).

1. Package tab: upload `margin-store-1.15.2.zip`.
2. Store listing tab: replace the description with the one in section 2 above, and replace
   `screenshot-2.png` and `screenshot-3.png` (the word card and the flashcard changed).
3. Privacy practices tab: replace the context-menu and host-permission justifications with the
   ones in section 3. Nothing else changes; the privacy policy link stays the same (the page
   itself was updated to name Wiktionary).
4. Test instructions tab (500 characters maximum):

```
No login needed. Open any PDF link (e.g. https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf): it opens in the Margin reader. Select text for the toolbar: highlight colors, Note, Translate. Translate sends only the selected text to Wiktionary (definition) and Google Translate. The toolbar icon opens the dashboard. Web pages are off by default (Settings). Bundled unmodified libraries: PDF.js, Tesseract.js (local OCR in WebAssembly, hence 'wasm-unsafe-eval'), pdf-lib.
```

5. Submit for review.
