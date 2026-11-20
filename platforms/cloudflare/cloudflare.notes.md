Under GDPR and the ePrivacy Directive, you cannot declare engagement tracking or client profiling as "strictly necessary." While checking a license key to unlock a feature is strictly necessary, storing an identifier on a user's machine to track their visit frequency, IP changes, or behavioral engagement requires explicit, prior opt-in consent for EU users. For US users under CCPA, you do not need prior consent, but you must disclose the collection in your privacy policy and provide an opt-out mechanism.

When building on Cloudflare Workers, Cloudflare evaluates the connection at the edge and securely injects this data into every request object with zero added latency:
1. Real IP Address: request.headers.get('cf-connecting-ip') provides the authenticated client IP, automatically defeating spoofed headers like HTTP_X_FORWARDED_FOR.
2. Geolocation: request.cf.city, request.cf.region, request.cf.country, and request.cf.timezone; replacing the need for the ip-api.com API.
3. ISP / Network: request.cf.asOrganization provides the name of the network owner, replacing any gethostbyaddr reverse DNS lookup.
4. TLS / Security: request.cf.tlsVersion and request.cf.tlsCipher provide information about the client's TLS connection, replacing the need for additional server-side TLS inspection.
5. Device / Client Info: request.cf.deviceType and request.cf.clientTrust provide information about the type of device and the trust level of the client, replacing the need for additional client-side fingerprinting.
6. Request Metadata: request.cf.httpProtocol and request.cf.requestPriority provide information about the HTTP protocol used and the priority of the request, replacing the need for additional server-side request analysis.
7. Client Network Info: request.cf.clientTcpRtt and request.cf.clientAcceptEncoding provide information about the client's network round-trip time and accepted encodings, replacing the need for additional client-side network diagnostics.
8. Edge Metadata: request.cf.ray and request.cf.colocation provide information about the Cloudflare edge location handling the request, replacing the need for additional server-side edge diagnostics.
9. Security Headers: request.cf.securityHeaders provides information about the security-related headers applied to the request, replacing the need for additional server-side header inspection.
10. Worker Metadata: request.cf.worker provides information about the Cloudflare Worker handling the request, replacing the need for additional server-side worker inspection.


Placing a JWT containing personal data into client-side storage exposes it to XSS attacks. It is recommended to store sensitive information in secure, server-side storage and only use short-lived tokens for client-side operations.

The modern standard separates the identity from the profile data using a lightweight client and a heavy edge:

The Client (Lightweight ID): Once the user consents, generate a simple, random UUID v4 (device_id). Store this single string in an HttpOnly, Secure, SameSite=Strict cookie. This protects the ID from malicious JavaScript and ensures it is automatically sent with every request to your API.

The Worker (Dynamic Profiling): When the client triggers an engagement event, the Worker receives the request and the device_id cookie.

The Assembly: The Worker reads the live network state directly from request.cf. It bundles the device_id, the requested feature, the cf.city, and the cf.asOrganization into a JSON payload and drops it into a Cloudflare Queue.

The Storage: A background Consumer Worker pulls batches from the Queue and inserts them into D1.

This architecture means you never have to trust the client to report its own environment, you never store PII in the browser, and you execute the profiling instantly without external API calls.