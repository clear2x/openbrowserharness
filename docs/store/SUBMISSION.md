# Store submission runbook (Chrome Web Store + Microsoft Edge Add-ons)

English | [中文](SUBMISSION.zh.md)

The upload artifact and every paste-ready text are prepared; execute the steps in order. Both stores share the same artifact and listing materials.

## The artifact (same package for both stores)

Download from [Releases · extension-v0.8.1](https://github.com/clear2x/openbrowserharness/releases/tag/extension-v0.8.1):

- `OpenBrowserHarness-extension-v0.8.1.webstore.zip` — the Chrome Web Store artifact
- The sibling `.zip` (unpacked layout) — the Edge Add-ons artifact (Edge accepts the same manifest layout)

For every later release: bump the three version fields → tag → CI builds the packages → upload the new version in each store's developer console. If the tag-triggered release workflow fails, fix the cause on `main` and dispatch the "Extension release" workflow there; it publishes the current tree under the version in `apps/extension/package.json`.

## Paste materials (all ready, field by field)

| Material | Location |
| --- | --- |
| Bilingual listing fields (name/category/language/description) | [listing.md](listing.md) |
| Per-permission justifications (12 permissions plus host permissions) | [listing.md](listing.md) 「Permission justifications」section (paste straight into the CWS Privacy tab) |
| Store icon (128×128, no alpha) | [screenshots/store-icon-128.png](screenshots/store-icon-128.png) |
| Store logo (300×300, required by Edge) | [screenshots/store-logo-300.png](screenshots/store-logo-300.png) |
| Marquee (1400×560) | [screenshots/promo-marquee-1400x560.png](screenshots/promo-marquee-1400x560.png) |
| Small promo tile (440×280) | [screenshots/promo-tile-440x280.png](screenshots/promo-tile-440x280.png) |
| Screenshots ×4 per locale (1280×800, zh and en sets) | [screenshots/shot-s1~s4(-en).png](screenshots/) |
| Privacy policy URL (both stores) | `https://clear2x.github.io/openbrowserharness/en/reference/privacy` |
| Website / support | `https://clear2x.github.io/openbrowserharness/` · `https://github.com/clear2x/openbrowserharness/issues` |

## 1. Chrome Web Store ($5 one-time registration fee)

1. **Register the developer**: open `https://chrome.google.com/webstore/devconsole/register`, sign in with your Google account, and pay the one-time $5 fee (a card is required; only you can do this step).
2. **Upload**: developer console → 「New item」→ upload `webstore.zip`.
3. **Store listing tab**: paste [listing.md](listing.md) field by field (description under the English locale; add the Simplified Chinese locale and paste the zh texts); upload the store icon, the marquee, and the screenshots.
4. **Privacy tab**:
   - Paste the privacy policy URL from above;
   - 「Single purpose」: *Run an AI agent that automates browsing on the pages the user directs it to*;
   - Paste each entry of [listing.md](listing.md)'s「Permission justifications」;
   - Data disclosures: check「does not sell / not used for unrelated purposes」and declare that page content goes only to the user's own configured LLM endpoint.
5. **Distribution tab**: Public; worldwide by default.
6. **Submit for review**. The `debugger` permission is a deep-review item; first review usually takes 1–7 days. Review feedback lands in the registered inbox; reply with extra material and resubmit.

## 2. Microsoft Edge Add-ons (free)

1. **Register the developer**: open `https://partner.microsoft.com/dashboard/registration`, sign in with your Microsoft account, pick **Individual** (free), and complete phone/identity verification (only you can do this step).
2. **Create the extension**: Partner Center → 「Create a new extension」→ upload the `.zip` (Edge accepts the CWS-shaped package).
3. **Submissions form**: Name/Description from [listing.md](listing.md) (Edge's China traffic is heavy, so lead with the Chinese description); the store logo (300×300) and promo images as above; the privacy policy URL as above.
4. **Review**: 1–3 business days after submission; status lives on Partner Center's Submission page.

## 3. The update cadence

Every later release (bump versions → tag → CI builds): upload the new version in each console → reuse the existing listing (a "what's new" note is optional) → submit. Update reviews usually run faster than first ones. CWS specifics: while a submission is pending review, the Store listing tab is read-only, so icon and screenshot changes wait for that review to finish; a listing-only change (icon, screenshots, description) goes through review on its own and leaves the live package in place; and an uploaded store icon overrides the package icon, so a new brand mark never reaches the store page until the icon is replaced by hand.

## Review risks and responses

- **The `debugger` permission** is the shared deep-review item in both stores. The response is built in: the permission justifications say "attach only to the tab a task targets, detach when the session ends", and the listing and site both stress "visible, approvable, exportable logs". If rejected, reply to the review email with a demo video (the probe family can record one).
- **On-device AI (v0.8.0)** adds `'wasm-unsafe-eval'` to the extension CSP and downloads model weights on demand. The response is built in: the reviewer notes state that the keyword allows WebAssembly only, that the models are data loaded by the bundled runtime, and they list every network endpoint. Keep those statements true for every release, and re-count `new Function` in the built package before reusing the notes.
- **First-submission advice**: submit Edge first (free, fast) to validate the listing wording, then Chrome, to avoid iterating against the $5 fee.
