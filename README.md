# ScreenRuler.net

ScreenRuler.net is a small, offline-first browser ruler with a background grid, calipers, protractor, bubble level, and device-aware calibration.

## Use it locally

This is a static site. Open `index.html` in a modern browser, or serve this folder with any static web server. The normal hosted build needs only these public files:

- `index.html`
- `about.html`
- `device-presets.js`
- `ruler-config.js`
- `ads.txt`

The optional Supabase Edge Functions in `supabase/functions/` provide the shared calibration templates, MobileAPI fallback and contact form. They require server-side environment variables and should be deployed separately.

## Deployment

Pushing `main` deploys the public site to HostGator via the GitHub Actions workflow in `.github/workflows/deploy.yml`. The GitHub repository needs these Actions secrets:

- `FTP_SERVER` — the HostGator FTPS hostname.
- `FTP_USERNAME` — a dedicated FTP account limited to `public_html/website_8a8b8e02`.
- `FTP_PASSWORD` — that account's password.

The workflow uploads only public runtime files and does not delete files already present on the server. It deliberately leaves cPanel-managed directories such as `.well-known` and `cgi-bin` untouched.

### Contact form setup

The form is intentionally unavailable until its server-side protections are configured. Before deploying the `contact` Edge Function, create a Cloudflare Turnstile widget for `screenruler.net`, add its public site key to `turnstileSiteKey` in `ruler-config.js`, and set these Supabase Edge Function secrets:

- `TURNSTILE_SECRET_KEY` — the Turnstile widget's secret key.
- `RESEND_API_KEY` — a Resend API key.
- `CONTACT_FROM_EMAIL` — a Resend-verified sender, for example `Screen Ruler <contact@screenruler.net>`.
- `CONTACT_RATE_LIMIT_SALT` — a random, private value used to hash visitor addresses.
- `ALLOWED_ORIGINS` — `https://screenruler.net` (add local origins only while testing).

Then apply the contact-rate-limit migration and deploy with `supabase functions deploy contact --no-verify-jwt`. The message recipient is fixed in the function as `geoffrey.brom@gmail.com`; it is never supplied by the browser.

## Privacy and community templates

The ruler itself stores a chosen calibration in the browser. When a person deliberately shares a calibration, the service receives the device model name or code and display dimensions/scale; it does not require an account or collect contact details. The shared-template database is private and accessed only through the narrowly scoped Edge Function.

The optional third-party MobileAPI lookup has a small shared allowance that resets on the 13th of each month. It is limited to three requests per visitor per allowance period before the shared allowance is touched. This helps keep the fallback available and does not store raw IP addresses: rate-limit keys use a one-way hash.

## Device data and attribution

`device-presets.js` is an offline, reviewed catalogue. It incorporates de-duplicated smartphone specifications from [Global Smartphone Database 2025](https://www.kaggle.com/datasets/rajibdab/global-smartphone-database-2025) (Apache-2.0) and a small set of adapted tablet records from the [OpenSTF device database](https://github.com/openstf/stf/tree/master/lib/units/device), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Storage/RAM variants are excluded where they do not affect display geometry. See [third-party notices](THIRD_PARTY_NOTICES.md) for the applicable data licences.

The MobileAPI fallback is optional and used only after local matching and shared templates cannot supply a result.

## Linting

`.hintrc` configures webhint (used by the Microsoft Edge Tools editor extension). Three rules are deliberately turned down, and one of them matters:

- **`meta-viewport` is off.** The viewport meta intentionally sets `maximum-scale=1.0, user-scalable=no`. Normally suppressing pinch-zoom is an accessibility fault, but this page is a ruler: its measurements are only correct at the CSS pixel scale it was calibrated against, so a pinch-zoom would silently make every reading wrong. **Do not re-enable this rule and "fix" the viewport tag** without first solving how calibration survives a user zoom.
- **`no-inline-styles` is off.** The hint asks for styles to move to an external CSS file, which does not apply to a deliberately single-file app.
- **`compat-api/css` ignores `scrollbar-width`, `scrollbar-color` and `scrollbar-gutter`.** These are unsupported on older Chrome and on Safari, but the `::-webkit-scrollbar` rules directly beneath them already cover those browsers.

Accessibility hints (`axe/*`) are left on and should be kept passing.

## Contributing and security

Issues and corrections to display dimensions are welcome. Please do not commit `.env` files, Supabase service-role keys, MobileAPI tokens, or any other secret. `ruler-config.js` intentionally contains only browser-public configuration, such as the Supabase publishable key and AdSense publisher ID.

If you find a security issue, please contact the maintainer privately rather than opening a public issue.

## Licence

The application source is available under the [MIT License](LICENSE). The bundled device data retains the attribution and licence obligations described above.
