# Store submission runbook (Chrome Web Store + Microsoft Edge Add-ons)

English | [中文](SUBMISSION.zh.md)

The upload artifact and every paste-ready text are prepared; execute the steps in order. Both stores share the same artifact and listing materials.

## The artifact (same package for both stores)

Download from [Releases · extension-v0.6.2](https://github.com/clear2x/openbrowserharness/releases/tag/extension-v0.6.2):

- `OpenBrowserHarness-extension-v0.6.2.webstore.zip` — the Chrome Web Store artifact
- The sibling `.zip` (unpacked layout) — the Edge Add-ons artifact (Edge accepts the same manifest layout)

For every later release: bump the three version fields → tag → CI builds the packages → upload the new version in each store's developer console.

## Paste materials (all ready, field by field)

| Material | Location |
| --- | --- |
| Bilingual listing fields (name/summary/description/category/language) | [listing.md](listing.md) |
| Per-permission justifications (debugger/tabs/host_permissions/storage/offscreen/sidePanel) | [listing.md](listing.md) 「Permission justifications」section (paste straight into the CWS Privacy tab) |
| Store logo (300×300, required) | [screenshots/store-logo-300.png](screenshots/store-logo-300.png) |
| Marquee (1400×560, required by CWS) | [screenshots/promo-marquee-1400x560.png](screenshots/promo-marquee-1400x560.png) |
| Small promo tile (440×280) | [screenshots/promo-tile-440x280.png](screenshots/promo-tile-440x280.png) |
| Screenshots ×3 (1280×800 family, bilingual sets) | [screenshots/shot-s1~s3(-en).png](screenshots/) |
| Privacy policy URL (both stores) | `https://clear2x.github.io/openbrowserharness/en/reference/privacy` |
| Website / support | `https://clear2x.github.io/openbrowserharness/` · `https://github.com/clear2x/openbrowserharness/issues` |

## 1. Chrome Web Store ($5 one-time registration fee)

1. **Register the developer**: open `https://chrome.google.com/webstore/devconsole/register`, sign in with your Google account, and pay the one-time $5 fee (a card is required; only you can do this step).
2. **Upload**: developer console → 「New item」→ upload `webstore.zip`.
3. **Store listing tab**: paste [listing.md](listing.md) field by field (Name/Summary/Detailed description under the English locale; add the Simplified Chinese locale and paste the zh texts); upload the logo, marquee, and 3 screenshots.
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

Every later release (bump versions → tag → CI builds): upload the new version in each console → reuse the existing listing (a "what's new" note is optional) → submit. Update reviews usually run faster than first ones.

## Review risks and responses

- **The `debugger` permission** is the shared deep-review item in both stores. The response is built in: the permission justifications say "attach only to the tab a task targets, detach when the session ends", and the listing and site both stress "visible, approvable, exportable logs". If rejected, reply to the review email with a demo video (the probe family can record one).
- **First-submission advice**: submit Edge first (free, fast) to validate the listing wording, then Chrome, to avoid iterating against the $5 fee.
