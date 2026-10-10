# Upstream provenance

The routing, translation, provider discovery, dashboard, history, pricing,
reasoning, context, and utility modules are adapted from
[12errh/antigravity-proxy](https://github.com/12errh/antigravity-proxy), commit
`457d0490ffdca79cce99b4c0acfb059aa83426b9` (MIT). The original copyright and
permission notice is retained in [LICENSE.upstream](LICENSE.upstream).

This integration adds a separate HTTP Gemini gateway, authenticated access,
isolated mutable data, a safe lifecycle CLI, built-in SQLite persistence, and
integration tests. It does not install a certificate, change hosts/DNS, replace
the Antigravity application, or run the upstream desktop-launching scripts.

The upstream provider/model tables and pricing are examples, not guarantees
of current availability or billing rates. Users can edit routes and pricing
in the dashboard. Token and cost totals are estimates.

## Logo

`dashboard/antigravity-logo.png` is the unmodified full-color icon downloaded
from [Google Antigravity's official press assets](https://antigravity.google/press)
([source PNG](https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png)).
It replaces the previous custom gateway mark in the README and dashboard.
