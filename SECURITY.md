# Security

Found a way to transmit without a key, read a key, take over the air, crash the station or harm a listener?
Please tell us first and privately: **contribute@opensourceorchestra.org** (subject "LIVE PIT security").
We answer within 48 hours, fix first, and credit you if you like.

Design notes: transmitter keys are stored only as SHA-256 hashes (KV `txkeys`); the admin key is a Worker secret
compared in constant time; keys travel in the URL fragment (never sent to servers); TURN credentials are
short-lived and only handed to listeners while a channel is live; the kill switch (`on_air:false`) overrides
every transmitter. Never commit `.dev.vars`, `wrangler.jsonc` secrets, or anything from a vault.
