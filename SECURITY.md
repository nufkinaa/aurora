# Security Policy

## Aurora's security model, honestly stated

Aurora is designed for a **trusted private LAN**. Library browsing, streaming,
and download requests are deliberately unauthenticated — the network boundary
(your firewall) is the security boundary. The admin panel is always
password-gated, the built-in web proxy refuses private/local addresses, and
profile passwords are a courtesy lock between household members, not hardened
auth. Do not expose an Aurora server to the public internet.

## Reporting a vulnerability

If you find something that breaks the model above — e.g. a way for an
unauthenticated LAN client to reach admin functionality, an SSRF/path-traversal
in any route, secret leakage, or anything exploitable even within the stated
trust model — please report it privately:

- **Preferred:** GitHub → Security tab → "Report a vulnerability"
  (private advisory).
- Please don't open a public issue for exploitable bugs before a fix exists.

You can expect an acknowledgement within a few days. This is a hobby project
maintained by one person — fixes ship as fast as realistically possible, and
reporters get credited in the fix commit unless they prefer otherwise.

## In scope

- Authentication/authorization bypasses (admin surfaces, profile gates)
- SSRF, path traversal, injection in any server route
- Anything that lets one household profile read another's private state
- Secret handling problems (.env, config, session tokens)

## Out of scope

- "The API has no auth" — by design; see the model above
- Issues requiring the attacker to already control the server or its machine
- The legality of content users choose to stream (see the README's Legal note)

## Supported versions

The `master` branch. There are no maintained release branches yet.
