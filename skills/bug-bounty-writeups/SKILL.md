---
name: bug-bounty-writeups
description: Learn bug bounty methodology from curated writeups, build recon and test checklists by vulnerability class, and report authorized findings.
---

# Bug Bounty Writeups

- Use this skill when the user asks for bug bounty methodology, a recon plan, a test checklist for a vulnerability class, or a way to learn from a published writeup.

- Use the source repo as a library of real writeups, not as a list of payloads to copy blindly.

- Test only targets you are authorized to test, such as a target inside a bug bounty program scope or a system you own, and use only your own test account.

## When to use

- Pick this skill when the task is authorized security testing, learning a vulnerability class, or turning a writeup into a repeatable check.

- Skip this skill for coding bounties with no security testing, such as building a forecaster or a game, and use the skill that fits that build instead.

- Stop and ask the user for the program scope, the authorized target, and the rules of engagement when any of those is missing.

## Source repo

- Read the curated list at [alexbieber/Bug_Bounty_writeups](https://github.com/alexbieber/Bug_Bounty_writeups) when you need a writeup by category.

- Treat the repo as a link index, since it holds one README with links and no code, tools, or recon scripts of its own.

- Expect about 600 writeup links across 16 categories, counted from the README on 2026-11-17, with XSS at 294 links and RCE at 68 links as the two largest groups.

- Expect the newest links to date from around 2022, since the repo was created in 2022 and has 10 commits, so verify every link before you cite it and prefer a live primary source when a link is dead or paywalled.

## Additional source repos

- Use [AlbusSec/Penetration-List](https://github.com/AlbusSec/Penetration-List) as the payload and fuzzing library for this skill, [W4L33Dx/Cyber-Monster](https://github.com/W4L33Dx/Cyber-Monster) as the deep procedure library, and [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) as the audit discipline source. None replaces the writeup index above: the writeups teach why a bug happened, Penetration-List gives the probes to test with, Cyber-Monster gives the step by step procedure for one technique, and the Cloudflare skill gives the coverage, validation, and severity discipline for the whole audit.

- Penetration-List (MIT, created 2021, 157 commits, about 1,400 stars, 228 files sampled 2026-11-17) holds one material folder per vulnerability class, plus dorks, fuzzing wordlists, theory notes, and runnable proof of concept scripts. Use it only on an authorized target, and treat every payload as a probe to verify by hand, never as proof on its own.

- Penetration-List adds material this skill had no checklist for: file upload bypasses, open redirect payloads, HTML injection payloads, GraphQL introspection and directory lists, API endpoint fuzzing wordlists, web cache deception headers and extensions, XSSI sample files, information disclosure dork lists, Log4Shell payloads in three levels, and command injection and file inclusion payload and parameter lists.

- Penetration-List also holds runnable scripts under `Vulnerabilities_Scripts`, such as cache poisoning denial of service checks, a clickjacking scanner, a Log4Shell scanner, a WordPress blind SQL script, and proof of concept scripts for CVEs from 2017 to 2023. Read a script before you run it, run it only against a target in scope, and never run a proof of concept that can change, delete, or corrupt data. The CVE scripts are old, so treat them as patterns and recheck the software version on the target before you conclude anything.

- Cyber-Monster (created 2026-11-15, one commit, 785 sub-skills across 19 families, 786 `SKILL.md` files sampled 2026-11-17) is a separate skill library with its own root `SKILL.md` and `ROUTING_TABLE.md`. Use it as a reference library you open when a task needs one technique in depth, and do not copy its hundreds of sub-skills into this skill.

- Route inside Cyber-Monster by matching the task to a trigger in its routing table, then open only that sub-skill's `SKILL.md` for the stage you are on, and open its companion files only when that procedure calls for them. Its red team `web-and-application` family alone holds 184 sub-skills, and its blue team families cover secure code review, detection engineering, forensics, and incident response.

- Each Cyber-Monster sub-skill states its preconditions, a baseline versus probe differential, a stop condition, and false positive traps. Follow that shape here too: record the baseline response first, then the probe, stop when the stop condition is met, and check the trap list before you call a difference a finding.

- Cyber-Monster's bug bounty workflow sub-skill adds two gates this skill should enforce: a scope gate that rejects any asset that matches the scope only by a substring of the domain, and a triage gate that rejects a self only effect, an out of scope asset, or a likely duplicate before you write a report. It also says to attach a programme required identification header to test traffic when the programme asks for one.

- Cyber-Monster chains a red finding into its blue counterpart, so a confirmed bug can move straight to a fix or a detection: secure code review for the code fix, detection engineering for a Sigma or SIEM rule, and incident response or forensics for containment and scoping. Use that handoff when the user asks what to do after a finding, not only how to find it.

- Cyber-Monster is a compiled library from many public datasets and projects, with a single commit and a short history, so verify any procedure it gives against the target and a primary source before you rely on it, and treat its own benchmark claims as the author's, not as verified fact.

- Use [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) as the audit discipline source for this skill. It is a coding-agent skill (MIT, created 2026-06-18, 14 commits, about 74,000 stars sampled 2026-11-17) that seeded Cloudflare's vulnerability discovery harness, and it is generic methodology, not Cloudflare product guidance: it contains no Cloudflare-specific checks, only a contact address for its authors.

- The Cloudflare skill audits a local codebase in six phases (recon, coverage-led hunting, candidate validation by a fresh verifier, structured findings, independent record verification, target-neutral reporting), and the checklists below are adapted from its attack-class files. Its multi-agent orchestration machinery, JSON findings schema, and Node.js validators are built for auditing source you own, so they are not copied into this skill; the checklists and the validation discipline are what transfers to bounty hunting.

- The Cloudflare skill's core rules that this skill now enforces: a candidate needs a named trust boundary and a concrete observed result; a missing best practice with no affected principal or resource is a hardening note, not a finding; severity comes only from demonstrated impact, never from how a bug feels; a deployment fact you cannot observe is a needs-validation lead with the exact unresolved fact, never a confirmed finding; and the agent that checks a finding is never the agent that found it, so re-verify every candidate from scratch before you report it.

## Read a writeup for a reusable technique

- Open the writeup and write down the entry point, the flawed assumption, the exact request or input that triggered the bug, and the impact in one sentence each.

- Ignore the bounty amount and the target name, since neither transfers to a new target.

- Ask what the tester noticed first, such as an unusual parameter, a verbose error, or a state change that no other request touched.

- Turn that observation into a check you can run on any similar feature, and keep the check in the checklist section below.

- Verify the technique on your own test account before you call it a finding.

## Recon workflow

- Confirm the scope first, then list the in scope domains, subdomains, and web applications before you send any active probe.

- Map the application by hand first, and note the login flow, the password reset flow, the payment flow, file upload, file download, search, and every state changing action.

- Collect JavaScript files, API endpoints, and hidden parameters during mapping, since the JavaScript tip below often finds the next test faster than clicking does.

- Keep a short log of what you tested, what you sent, and what the application returned, so a finding stays reproducible.

- Stop active testing on anything outside the written scope, even when a link or a redirect leads there.

## Test CORS misconfiguration

- Test CORS only on an authorized target, and use your own test account for every authenticated check.

- Send a request with an attacker origin first, using a command like `curl -s -i -H "Origin: https://evil.com" https://target.com/api/profile`.

- Repeat the same request with `Origin: null` as the next origin to test.

- Repeat the same request with `Origin: https://target.com.evil.com` as the next origin to test, since a suffix check can mistake that host for the target.

- Read the response headers for each origin, and look for the response echoing the Origin you sent in `Access-Control-Allow-Origin` together with `Access-Control-Allow-Credentials: true`.

- Treat an echoed origin plus credentials as a real risk, since a malicious site can then read authenticated responses from the target in the victim browser.

- Confirm the impact with your own account only, by showing that an authenticated cross origin request can read data that belongs to that account, and never read or copy another real user account data.

- Record the request, the origin you sent, the two response headers above, and the data you could read, so the report is reproducible.

- For bypass variants beyond the three origins above, use the CORS material folder in Penetration-List and the CORS sub-skills in Cyber-Monster, which cover a credentialed wildcard, a reflected origin including null, and subdomain trust, and test each variant the same way, one origin at a time.

## Mine JavaScript files

- Collect JavaScript files before manual clicking, since minified JavaScript often holds endpoints, keys, and internal paths that the visible interface hides.

- Run a crawler that extracts JavaScript, using a command like `katana -u https://target.com -jc | grep -E "api|key|token|secret|admin"`.

- Download the JavaScript files that the command returns, and search each one for API keys, tokens, secrets, hidden endpoints, internal paths, debug flags, and source map references.

- Check for a source map file beside any JavaScript file, since a `.js.map` file can expose the original source and comments.

- Treat every match as a lead, not as a finding, and verify it by hand before you report it.

- Confirm a suspected key is live, in scope, and usable, and confirm a suspected endpoint exists and returns data you are allowed to see.

- Report only a verified leak or endpoint, with the file, the line, and the request that proves it, and never use a live key to access data outside the scope.

- For a deeper procedure on the same lead, open the api key and secret exposure sub-skill in Cyber-Monster, which treats a secret in JavaScript as its own technique with its own preconditions and false positive traps.

## Audit discipline from Cloudflare security-audit

- Map coverage before you hunt, using the Cloudflare shape: list every entry surface, every trust boundary, and every attack class that applies, then mark each combination as covered, candidate, or blocked, and never claim a target is fully tested after one pass, since Cloudflare found one run catches roughly half of what repeated runs catch in total.
- Test only in scope targets with your own test account, and treat any deployment fact you cannot observe, such as a proxy, cache, identity provider, or cloud setting, as a lead that needs validation, never as a confirmed finding.
- Separate the finder from the verifier: whoever found a candidate must not be the one who confirms it, so retest every candidate from scratch, re-read the code or re-send the requests, and try to disprove it before you report it.
- Give every candidate one of three verdicts, and record rejected ones so you do not retest them: confirmed means a complete trace plus an observed result across a named trust boundary; needs validation means a source grounded lead with one exact unresolved fact and a safe check that would resolve it, with no severity; rejected means the source or a test disproved the claim.
- Treat a missing best practice with no affected principal or resource as a hardening note, not a finding, and treat a defense in depth gap as a finding only when a layer that should stop the attack is actually missing and the boundary is crossed.
- Record the baseline response before every probe, then the probe response, and stop when the check is settled either way, instead of expanding a probe into a chain, a stress test, or a live availability test.

## Bug classes and test checklists

- Use the counts below to pick where to start, and open the linked writeups in the source repo for the full story behind each check.

- Test cross site scripting by submitting input in every reflected and stored field, then check whether the application encodes it on output and whether an event handler or a template sink runs it.

- Test cross site request forgery by sending a state changing request from another origin without the token, then check whether the application still accepts it.

- Test clickjacking by framing a sensitive page, then check whether the application sets a framing header or a frame ancestors policy.

- Test local file inclusion by changing a file path parameter to a known local path, then check whether the application returns the file or an error that leaks its layout.

- Test subdomain takeover by listing dangling DNS records, then check whether the pointed service is unclaimed and lets you claim it.

- Test authentication bypass by changing identifiers, roles, and session values, then check whether the application trusts the client value without a server check.

- Test SQL injection by sending a quoted input in a data field, then check whether the query changes, errors, or returns different rows.

- Test insecure direct object reference by changing an object id to another user object id, then check whether the application returns it without an ownership check.

- Test two factor authentication by replaying codes, skipping the step, and brute forcing with rate limits in mind, then check whether the application still lets the login finish.

- Test server side request forgery by giving the application a URL you control, then check whether it fetches internal addresses or cloud metadata.

- Test race conditions by sending the same state changing request many times at once, then check whether the application counts or charges it twice.

- Test remote code execution by tracing user input into a command, template, or deserialization call, then check whether the application runs it without a sandbox.

- Test file upload by uploading a file with a changed extension, content type, magic header, or null byte, then check whether the application stores it, serves it, or executes it, and whether an upload can smuggle another bug such as cross site scripting, server side request forgery, or XML external entity injection.

- Test open redirect by changing a redirect parameter to a domain you control, then check whether the application redirects there without validation, and whether the redirect can carry a script for a cross site scripting chain.

- Test HTML injection by submitting markup in a reflected or stored field, then check whether the application renders it as HTML, and whether it can change the page for another user.

- Test GraphQL by sending an introspection query and enumerating the schema, then check whether fields, mutations, and resolvers enforce authorization, whether batching and query depth have limits, and whether an object id inside a query returns another user object.

- Test an API by fuzzing its endpoints with the endpoint wordlists, then check each endpoint for missing authorization, excessive data exposure, mass assignment of fields such as a role, and missing rate limits, and test every object id and function as its own authorization check.

- Test web cache deception by requesting a sensitive page with a path extension that a cache may treat as static, then check whether the cached response leaks another user data, and whether cache headers mark the response as private or uncacheable.

- Test information disclosure by searching with the dork lists for indexed sensitive files, directories, and documents, then check whether what you find is in scope and belongs to the target, and report only what an authorized test is allowed to see.

- Test command injection by sending a command separator or a time delay in an input that reaches a shell, then check whether the application runs it or delays, and confirm with an out of band callback to a server you control only when the scope allows it.

- Test cross site scripting inclusion by loading a JSON or script endpoint from another origin, then check whether the response is a valid script that leaks data when included, and whether the application sets the right content type and framing protections.

- Test Log4Shell and other known CVE proofs only against in scope software whose version you have confirmed, using the leveled payloads as a non destructive check first, and stop at proof of the lookup, never at a command that changes the target.

## Test token and identity binding

- Test only on an authorized target with your own test account, and never use another real user token or session.
- Test JWT verification by sending a token with no signature, a changed algorithm, a token signed with a different key, and a token for another service or audience, then check whether the server still accepts it and which identity it binds.
- Test JWT claim binding by changing the issuer, audience, expiry, and subject of a valid token, then check whether the server checks each claim or only the signature.
- Test OAuth and OpenID Connect by changing the redirect URI, replaying an authorization code, dropping the state parameter, and swapping the identity provider in a multi provider flow, then check whether the server binds the code and the token to the session, client, and provider that started the flow.
- Test API key scope by using a key on tenants, resources, and actions outside its granted scope, then check whether the server enforces the scope or trusts the key alone, and check whether request parameters can override the key binding.
- Test API key exposure by searching client bundles, URLs, redirects, logs, and error responses for keys, then confirm the key type and the authority it grants before you report it, since a public identifier called a key is not a secret.
- This section covers token and binding defects; the existing authentication bypass checklist covers identifier and role changes, and the session section below covers session and MFA checks.

## Test HTTP framing, cache, and host trust

- Test only on an authorized target, and never poison a shared cache with another user data.
- Test request smuggling by sending duplicate Content-Length headers, conflicting Transfer-Encoding values, and header names with different casing or whitespace, then check whether the front end and the back end assign the same bytes to the same request, and confirm a real cross request effect before you report it.
- Test cache poisoning by sending a request value that changes the response, such as a forwarded host, scheme, cookie, or language header, then check whether that value is missing from the cache key, and confirm the poisoned response is served to another user before you call it a finding.
- Test host header trust by sending a Host and X-Forwarded-Host you control, then check whether password reset links, callbacks, tenant routing, or cache keys use it without validation.
- Test response header injection by sending control characters in a value that reaches a Location, Set-Cookie, or Content-Security-Policy header, then check whether the framework rejects it and whether the response actually changes in a security relevant way.
- This section extends the existing web cache deception checklist, which covers private responses cached as static assets; use both, and treat a missing header or a cache difference with no cross user impact as a hardening note.

## Test SSRF through redirects, rebinding, and parser differentials

- Test only on an authorized target, and use a server you control as the callback target, with no access to internal addresses beyond what the scope allows.
- Test SSRF through redirects by giving the application a URL you control that redirects to an internal address, then check whether the application follows it and fetches internal services or cloud metadata.
- Test SSRF through DNS rebinding by pointing a hostname at a public address first and an internal address second, then check whether the application resolves it twice and fetches the internal address on the second resolution.
- Test SSRF through parser differentials by sending URLs that two parsers read differently, such as different handling of userinfo, ports, encoding, or trailing characters, then check which interpretation the fetcher uses and whether it reaches an internal address.
- Test SSRF through notification and webhook URLs by setting a callback URL you control, then check whether the server fetches it and whether it validates the destination against internal networks after redirects.
- This section extends the existing server side request forgery checklist, which covers giving the application a URL you control; use both, and confirm the fetched internal address or metadata with your own test account only.

## Test session lifecycle and account recovery

- Test only with your own test accounts, and never read or copy another real user session or recovery data.
- Test session fixation by taking a session identifier issued before login, then check whether the server rotates it on login, account switch, MFA completion, and impersonation, and whether the old identifier still works.
- Test session invalidation by logging out, changing the password, and revoking a session, then check whether the old session, refresh token, signed cookie, and websocket state still work, including on fallback endpoints.
- Test MFA enrollment by enrolling or replacing a second factor with only a valid first factor, then check whether the server requires fresh authentication first, and whether a disabled or stale factor still authorizes sessions.
- Test step up binding by completing a challenge for one action, account, or tenant, then check whether the upgraded assurance applies to a different action, account, or tenant, and whether an alternate route skips the assurance check.
- Test password reset by requesting a reset token, then check its randomness, binding to the user and action, expiry, one time use, rate limits, and whether prior tokens and sessions are invalidated, and check whether the reset link host comes from a trusted value.
- Test account linking by adding an identity provider, passkey, email, or phone to an account, then check whether it requires a current authenticated session, verified ownership of the new identity, and callback state bound to the account that started the linking, and check unlink and relink paths for identifier collisions.

## Test client-side trust

- Test only on an authorized target with your own test account, and confirm every client finding reaches a victim session, another origin, or shared persistence, since self injection is not a finding.
- Test DOM XSS by tracing location fields, document.referrer, window.name, message data, and storage into innerHTML, document.write, string evaluating APIs, executable URLs, and framework escape hatches, then check whether the framework already escapes the value.
- Test DOM clobbering by injecting id or name attributes that shadow a global, form property, or configuration object, then check whether the markup survives and the shadowed value is actually used.
- Test prototype pollution by sending an attacker controlled key into a recursive merge or path assignment, then check whether a reachable gadget consumes the polluted property to change authorization, execution, navigation, or rendering, since pollution without a gadget is not a finding.
- Test postMessage trust by sending message data to a handler, then check whether it uses an exact origin allowlist and the expected event source, and check whether sensitive data is sent to an unrestricted target origin.
- Test cross site WebSocket use by opening a WebSocket upgrade with ambient cookies from an untrusted origin, then check whether the server checks Origin or a channel token and whether a security relevant message handler exists.
- Test service worker scope by checking whether attacker influenceable content can become the registered worker script or widen its scope, then verify the final script URL, MIME type, origin, and scope, and check whether the worker caches personalized responses without account or tenant in the cache key and serves them after logout or account switch.
- Test cross site leaks by finding one concrete predicate, such as whether a private object or role exists, that an attacker page can distinguish through load or error events, frame state, redirect behavior, timing, cache state, or response size while the browser attaches victim credentials, and confirm the response headers or rendering choice that would remove the oracle.
- Test clickjacking with the existing checklist, and treat missing framing headers on read only content as a hardening note.

## Test LLM and agent trust boundaries

- Test only on an authorized target with your own test account and your own prompts, and never use another real user conversation, memory, or data.
- Test indirect injection by placing attacker controlled text in a document, page, file, issue body, or tool response that a retrieval pipeline can ingest, then check whether it enters another principal model context and enables a capability, disclosure, or sink that principal did not intend, since persuasive text alone is not a finding.
- Test cross tenant context bleed by checking whether conversation history, embeddings, retrieval results, or prompt caches are keyed by tenant and access control, then confirm an alternate query, shared cache, or batch path that omits the filter.
- Test memory poisoning by writing attacker controlled content into persistent memory, then check whether it later shapes another task, user, or privileged session, and whether low trust observations become durable instructions.
- Test tool argument injection by tracing model produced arguments into SQL, shell, file, URL fetch, or privileged APIs, then check whether the handler validates each field, since a tool schema only narrows shape and does not prove authorization or safe values.
- Test confused deputy authority by checking whether an agent service identity performs an operation the requesting principal could not perform through the normal interface, and whether the tool handler re-checks the requester permission on the named resource.
- Test action confirmation binding by approving one described action, then check whether execution can use changed arguments, a different resource, a different principal, or a later model turn, and whether a retry or resumed session reuses the approval for a mutated or duplicate side effect.
- Test MCP and sub-agent trust by checking whether delegated calls carry the full session and credentials instead of the least authority required, whether two servers can claim the same tool or resource identity, and whether tool descriptions or metadata supplied by a peer are trusted as policy instead of a deterministic allowlist.
- Test model output rendering by tracing model output into HTML, Markdown, template, URL, or command sinks, then check whether the sink encoding and policy apply, and treat renderer behavior outside the target as a lead that needs validation.

## Test supply chain and release trust

- Test only against a target in scope, and never publish, alter, or replace a real release, artifact, or workflow run.
- Test dependency confusion by reviewing resolver configuration, package names, source priority, lockfile and checksum use, and fallback registries, then check whether an unintended public namespace can supply a package the build trusts.
- Test mutable build inputs by listing branches, tags, unverified submodules, downloaded tools, generated assets, and floating CI actions the build consumes, then check whether a lower trust writer can change what a trusted build outputs.
- Test CI workflow injection by finding pull request, issue, fork, or dependency update events that run contributor controlled code, then check the trigger type, checkout ref, approval gate, environment protection, and which secrets or write tokens the job can reach.
- Test workflow expression confusion by tracing attacker controlled branch names, commit messages, issue fields, or artifact names into shell commands, template expressions, paths, or privileged workflow inputs.
- Test cache and artifact trust mixing by checking whether a lower trust job can populate a cache, artifact, or shared workspace that a higher trust job later restores and executes or releases, then check cache keys, namespaces, artifact producer identity, and digest binding.
- Test release substitution by following one artifact from build to promotion, then check whether tests, review, signature, and publication all refer to the same immutable digest, or to a mutable tag, filename, or channel that can be swapped.
- Test update trust by checking whether an updater authenticates the version, product, platform, channel, target path, and expiry as well as the payload bytes, and whether a signature without policy binding is accepted.

## Test tenant isolation and data lifecycle

- Test only on an authorized target with your own test accounts, and never read, export, or restore another real user data.
- Test tenant enforcement by running the same read, update, delete, list, count, and bulk operation as two dummy tenants, then check whether every path, including background jobs, admin paths, import paths, and legacy paths, binds the object to the authenticated tenant or owner, since a tenant field on a record is not enforcement.
- Test composite key collisions by checking whether cache keys, object paths, search document IDs, temporary files, and deduplication keys include the tenant or environment, then confirm two principals can overwrite or retrieve the same logical key.
- Test derived copy drift by changing a record ACL or lifecycle state, then check whether search, cache, index, preview, thumbnail, RSS, export, and backup copies still serve the old version, and whether retrieval filters at read time as well as at ingestion.
- Test export scope by triggering an export, snapshot, or backup as a low privilege user, then check whether it includes other tenants, inaccessible fields, soft deleted data, secret values, or revision history above the requester access, and check authorization on the final download artifact.
- Test import and restore authority by restoring or importing an archive, then check whether it bypasses owner, schema, ACL, uniqueness, or validation rules, overwrites existing resources, or recreates records in a tenant the requester cannot write.
- Test soft delete bypass by deleting a record, then check whether direct lookup, search, relation traversal, object links, background processors, and restore still return or act on it, and whether a soft deleted identifier can be re-registered.
- Test stale authorization by removing a membership, updating an ACL, withdrawing consent, or revoking a secret, then check whether sessions, caches, subscriptions, jobs, and materialized data still authorize future operations.
- This section extends the existing insecure direct object reference checklist, which covers changing one object id; use both, and require a concrete unauthorized disclosure or mutation, not a general response difference.

## Test resource exhaustion with shared impact

- Test only on an authorized target, and never stress, saturate, or run availability tests against a live or shared service; use code level reasoning, small boundary fixtures, mocked paid calls, and strict local limits instead.
- Test superlinear parsing by sending a small input with deep nesting, repetition, or adversarial patterns to regex, parsers, template expansion, or graph traversal, then check whether the accepted depth and cardinality produce a bounded growth curve locally.
- Test decompression amplification by sending a small compressed, sparse, nested, or aliased input, then check whether limits apply after every expansion stage, including archives, images, and structured documents.
- Test query amplification by sending a request with deep filters, broad sorts, or expansion fields, then check whether pagination, depth, and cardinality are bounded, and whether one request fans out into many downstream calls.
- Test unbounded accumulation by checking whether bodies, uploads, sessions, cache keys, metrics labels, log fields, subscriptions, and pending jobs have per item and aggregate limits with cleanup on disconnect, timeout, and cancellation.
- Test pre-authentication work by listing expensive parsing, key lookup, cryptography, decompression, and external requests that run before authentication and the earliest size or rate gate, then compare minimal requester effort to shared service cost.
- Test quota accounting by checking whether the accounting dimension, such as IP, route, tenant, or key prefix, can be influenced by the requester to escape a budget or consume another principal allocation.
- Test retry and poison record behavior by checking whether timeouts, dependency errors, and malformed records trigger unbounded retries without jitter, ceilings, or deduplication, and whether one malformed record blocks a shared queue or partition.
- Treat a missing rate limit with no concrete shared impact as a hardening note, and name the input, the requester work, the service amplification, the shared blast radius, and the recovery path for every real candidate.

## Test protocol, RPC, and messaging trust

- Test only on an authorized target with your own test account, and use bounded local fixtures rather than live broker or queue traffic.
- Test interceptor gaps by listing every route to the same operation, including streams, reflection, health checks, gateway transcoded paths, and compatibility services, then check whether authentication and authorization apply to each one.
- Test envelope and payload identity by checking whether authorization uses routing or envelope metadata while the handler acts on a conflicting tenant, account, subject, or sender in the message body, and confirm which source is authoritative.
- Test per item authorization by sending a stream, subscription, batch, or bulk message whose later items name different resources, then check whether authorization is re-checked after role, membership, or token revocation.
- Test replay and idempotency by replaying a message or request, then check whether deduplication happens before mutation, whether the deduplication key can collide across tenants or operations, and whether out of order or stale messages overwrite newer state.
- Test callback correlation by checking whether correlation IDs are predictable, reused, or shared across tenants, then confirm a response, webhook, or acknowledgment can satisfy another caller pending operation.
- Test broker scope by checking whether a publisher or subscriber can select another tenant topic, wildcard, consumer group, partition, reply queue, or dead-letter route, and whether dead letter queues, error topics, and tracing expose secrets or cross tenant payloads.
- This section extends the existing GraphQL and API checklists, which cover schema enumeration and endpoint fuzzing; use both, and require the authenticated peer, the accepted message, and the unauthorized mutation or disclosure for every candidate.

## Test business logic state and numeric handling

- Test only on an authorized target with your own test account, and use only values and flows the scope allows.
- Test state machine violations by skipping steps, going backwards, replaying a completed flow, and failing a middle step, then check whether the application reaches an invalid state or keeps the effect of the earlier step without a rollback.
- Test numeric manipulation by sending negative, zero, maximum, and fractional values, and values that change type between string and number, then check whether the application counts, charges, or grants the wrong amount.
- Test time-based logic by sending requests at exact expiry boundaries, across timezones, and with clock skew between components, then check whether expiry, scheduling, and rate windows behave as intended.
- Test default and fallback behavior by removing configuration, turning off a feature flag, and making a dependency unavailable, then check whether the security posture fails open or stays enforced.
- Test second-order use by storing data safely, then check whether a different code path later uses it in a dangerous context, such as a field name becoming a JSON path, a slug becoming a file path, or stored text entering raw rendering.
- Test cross-component trust by comparing what one component guarantees with what the next component assumes, including truncation, type coercion, normalization, and tenant scope.
- Test scope growth by checking whether a token, API key, plugin, OAuth grant, or MCP capability becomes broader after delegation, refresh, caching, or role change, and name the concrete operation the resulting principal should not have.
- Test rollback and recovery by restoring, undeleting, or rolling back state, then check whether the restored state applies current ownership, validation, and authorization.

## Test cryptography and secrets handling

- Test only on an authorized target with your own test account, and never use a live secret to access data outside the scope.
- Test randomness by checking whether security critical values such as tokens, keys, and nonces come from a weak or predictable generator, and whether the same value can repeat.
- Test secret handling by searching logs, error messages, URLs, and client visible responses for secrets, then confirm the secret is live and in scope before you report it.
- Test key derivation and verification by checking whether HMACs, signatures, and encrypted values are verified before use, whether nonces are reused, and whether ECB mode, unauthenticated encryption, or a static IV is used.
- Test failure behavior by making a crypto operation fail, then check whether the error path falls back to no crypto instead of failing closed.
- Test timing side channels by checking whether secret comparison uses a constant time comparison, and treat a timing difference you can measure as a lead, not as proof on its own.

## Test native, mobile, and IPC trust

- Test only on an authorized target with your own test account and dummy profiles, and use an isolated machine or emulator for local checks, never another real user app or data.
- Test deep link confusion by invoking a custom scheme or deep link that mutates state, imports data, completes authentication, or selects an account, then check whether it requires a current session and a one time callback binding.
- Test webview bridge overreach by checking whether remote or attacker controlled frames can reach a JavaScript to native bridge intended only for packaged content, and whether the bridge allows arbitrary files, commands, IPC methods, or credentials through a generic method.
- Test IPC peer authentication by checking whether a Unix socket, named pipe, XPC, Binder, D-Bus, or loopback listener accepts a lower trust peer without operating system credentials, code identity, or channel ownership, and whether request fields can select another user, tenant, or profile.
- Test privileged helper confusion by checking whether a low privilege caller can select a privileged command, file, service, or setting through a helper without per operation authorization on the final normalized destination.
- Test local file handling by checking whether a privileged read or write follows a symlink, mount, or case change between the check and the use, and whether a credential store item, token file, backup, log, or clipboard entry is readable by another app or profile with less authority.
- Keep this section short in a web bounty: most web programs are out of scope for native, mobile, and IPC testing, so confirm the program scope covers the app or component before you test any of it.

## Sweep the obvious exposures

- Run this sweep on every target before deep testing, since these exposures are easy to overlook because everyone assumes someone else already checked them.
- Search the source and the deployed target for hardcoded passwords, API keys, tokens, and secrets, and for TODO, FIXME, HACK, and XXX comments that mention security, such as a skipped permission check or missing validation.
- Check whether debug or development mode can be enabled in production through an environment variable, query parameter, or header, and whether test, example, or seed credentials work outside a test environment.
- Probe for unprotected debug, admin, test, status, health, metrics, environment, and config endpoints, and check whether .env files, credential files, private keys, or certificates are checked into the repository or served by the target.
- Check whether the dependency tree is pinned and whether the lockfiles contain known CVEs, and whether the repository history still holds secrets or reverted security fixes that were committed and then removed.
- Check whether eval, exec, dynamic import, or child process calls take attacker influenced input, and whether error responses return stack traces, internal paths, or SQL errors in production.
- Verify every flag before you report it: a cookie missing HttpOnly matters only when the cookie holds security sensitive data, and an error field matters only when it is actually populated with sensitive data, so trace the impact first.
- For CORS checks, use the dedicated CORS section above rather than this sweep.

## Representative writeups

- [From P5 to P2 to 100 BXSS](https://medium.com/@mohameddaher/from-p5-to-p5-to-p2-from-nothing-to-1000-bxss-4dd26bc30a82)

- [Google Acquisition XSS (Apigee)](https://medium.com/@TnMch/google-acquisition-xss-apigee-5479d7b5dc4)

- [Exploiting an SSRF trials and tribulations](https://medium.com/a-bugz-life/exploiting-an-ssrf-trials-and-tribulations-14c5d8dbd69a)

- [SSRF on PDF generator](https://medium.com/@michan001/ssrf-on-pdf-generator-36b81e16d67b)

- [Microsoft RCE bugbounty](https://blog.securitybreached.org/2020/03/31/microsoft-rce-bugbounty/)

- [Attacking helpdesk RCE chain on deskpro with bitdefender](https://blog.redforce.io/attacking-helpdesks-part-1-rce-chain-on-deskpro-with-bitdefender-as-case-study/)

- [How I bought my way to subdomain takeover on tokopedia](https://medium.com/bugbountywriteup/how-i-bought-my-way-to-subdomain-takeover-on-tokopedia-8c6697c85b4d)

- [How a simple CSRF attack turned into a P1](https://ladysecspeare.wordpress.com/2020/04/05/how-a-simple-csrf-attack-turned-into-a-p1-level-bug/)

- [Tricky oracle SQLI situation](https://blog.yappare.com/2020/04/tricky-oracle-sql-injection-situation.html)

- [Exploiting a Race condition vulnerabililty](https://medium.com/@vincenz/exploiting-a-race-condition-vulnerability-3f2cb387a72)

## Turn a writeup into a test checklist

- Copy the trigger, the input, and the vulnerable feature into a checklist item, and drop the target name and the bounty amount.

- Add the expected safe behavior beside each item, so a pass and a fail are both clear.

- Run the checklist against one feature at a time, and mark each item with the request you sent and the response you got.

- Keep items that found nothing, since a clean check is still evidence and it stops you from retesting the same thing.

- Share the checklist with the user before a long test run, so the scope and the plan stay visible.

## Grade a finding before you report it

- Assign severity only from demonstrated impact, and never let overall severity exceed the impact you actually observed.
- Use critical when an unauthenticated actor gains code execution, full data store access, or takeover of arbitrary accounts.
- Use high when an actor fully defeats an explicit security control with real consequences, such as authentication bypass, cross tenant read or write, stored script execution affecting other users, authenticated code execution, or an unauthenticated remote stop of a shared service.
- Use medium when the boundary violation is real but the blast radius is limited, the preconditions are uncommon, or the consequences stay inside a narrow resource set.
- Use low when the finding discloses non secret internals or needs sustained effort for minimal gain.
- Use informational for a confirmed but minimal impact observation that is mainly useful as a prerequisite inside a larger finding.
- Use the high versus medium test when you are unsure: does the demonstrated result fully defeat an explicit control for an action with real consequences, or only weaken it, and if you cannot state the concrete damage, the severity is lower than it feels.
- Give a needs validation lead no severity at all, and give a rejected candidate no severity either; severity belongs only to confirmed findings.

## Report a finding

- Write the title as the vulnerability class plus the affected feature, with no target name in the title unless the program asks for it.

- Describe the impact in one paragraph, using only data you observed with your own test account.

- Give exact reproduction steps, including the request, the input, and the response, so a reviewer can repeat it without guessing.

- Attach a screenshot or a log excerpt only when it proves the impact, and redact other user data and secrets first.

- Suggest a fix that matches the root cause, such as server side authorization, output encoding, or a strict allowlist, rather than a filter on one payload.

## Write a report that gets triaged fast

- Read this section before you write a bounty report, and again after you finish the test run. It is the user's standing rule for reports (added 2026-11-18): a clear report plus strong proof plus real impact means faster triage and a better chance at a bounty.
- Before you write, check and do all of these: read the program scope and rules and confirm the bug is in scope; check disclosed reports and the changelog for duplicates; test safely on your own account, never touch another user data, and avoid denial of service; re-verify the finding and rule out a false positive.
- Structure every report like this: 1. Title — specific: bug class plus location plus impact. Wrong: "XSS on the website". Right: "Stored XSS in the comment field at /posts/{id} allows session takeover". 2. Summary — two or three sentences: what the bug is, where it is, what it causes. 3. Severity — propose Low, Medium, High, or Critical, ideally with a CVSS score and the reason. Do not inflate it; your credibility is at stake. 4. Reproduction steps — the most important part. A stranger must be able to follow them from zero: URL, parameters, HTTP method, account and role, full payload or request, plus browser and version. 5. Proof of concept — screenshots, a short video, or a minimal script. Redact sensitive data. Prove the impact without causing damage. 6. Impact — realistic scenarios only: who is affected, what data is reachable, what an attacker can do. Do not speculate wildly. 7. Fix recommendation — short: input validation, output encoding, server-side authorization checks, rate limiting. Optional, but teams like it. 8. Extra info — test environment, date and time, CWE or OWASP references.
- Acceptance tips: one report per bug, unless it is a chain and you explain the chain; professional and neutral language, do not demand or mention the bounty up front; frame the business impact (account takeover, data leak, remote code execution usually score highest); always include repeatable proof; stop once the proof is enough, do not exploit further; answer clarifications fast and politely; follow the disclosure policy and do not publish before you are allowed to.
- Common mistakes that get reports rejected: a title that is too generic; ambiguous reproduction steps; reporting scanner output without verification; inflated severity; reporting out-of-scope or known issues; spamming duplicate or low-quality reports.
- Short template: Title: [Bug] in [component] allows [impact]. Then Summary, Severity (CVSS), Reproduction steps, PoC, Impact, Recommendation, Environment.

## Available connectors

- Use `muse.connector_search` to find other connectors and `muse.skill_search` to find related skills.

- If nothing here fits, look on the web for a maintained API or MCP server and set it up with [Custom Connectors and MCPs](/opt/muse/skills/custom-connector-setup/SKILL.md), or build a custom connector.

## Websites

- [alexbieber/Bug_Bounty_writeups](https://github.com/alexbieber/Bug_Bounty_writeups) for the curated writeup index by vulnerability class.

- [AlbusSec/Penetration-List](https://github.com/AlbusSec/Penetration-List) for payloads, dorks, fuzzing wordlists, and proof of concept scripts by vulnerability class.

- [W4L33Dx/Cyber-Monster](https://github.com/W4L33Dx/Cyber-Monster) for the 785 sub-skill procedure library and its routing table, red and blue team.

- [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) for the multi-phase audit discipline, coverage and validation rules, and attack-class checklists adapted in the sections above.

- [HackerOne Hacktivity](https://hackerone.com/hacktivity) for disclosed reports that show how a finding was reported and fixed.

- [PortSwigger Web Security Academy](https://portswigger.net/web-security) for labs that teach each vulnerability class with a safe target.

## Alternatives for better results

- Learn one vulnerability class deeply before you move to the next, since a deep check finds more than a shallow pass over many classes.

- Reuse a checklist from a writeup on a feature that matches the target, rather than starting from a generic payload list.

- Test the same feature in a second role or a second account, since authorization bugs often hide behind a role change.
