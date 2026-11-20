export default {
  // 1. Handles HTTP requests (Webhooks and API calls)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook/paddle") {
      
      const verification = await verifyPaddleSignature(request, env.PADDLE_WEBHOOK_SECRET);
      
      if (!verification || !verification.isValid) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Safe to process the event
      const event = verification.body;
      
      if (event.event_type === "transaction.completed") {
        // Insert into D1 and update KV
      }

      return new Response("OK", { status: 200 });
    }


    
    // Provisioning
    if (url.pathname === "/webhook/paddle") {
      // Verify signature, write to D1, update KV
      return new Response("Webhook processed", { status: 200 });
    }

    // Tracking
    if (url.pathname === "/api/track") {
      const event = await request.json();
      // Instantly drop onto Queue, do not wait for DB
      await env.USAGE_QUEUE.send(event);
      return new Response("Event queued", { status: 202 });
    }

    // Catch-all for other routes
    return new Response("Not Found", { status: 404 });
  },

  // 2. Handles Queue batches automatically in the background
  async queue(batch, env, ctx) {
    const events = batch.messages.map(msg => msg.body);
    
    // Prepare a batch of D1 statements
    const statements = events.map(event => 
      env.DB.prepare("INSERT INTO usage_logs (user_id, feature, timestamp) VALUES (?, ?, ?)")
        .bind(event.userId, event.feature, event.timestamp)
    );

    // Execute all inserts in one fast transaction
    await env.DB.batch(statements);
  }
}

/**
 * Verifies a Paddle webhook signature using the native Web Crypto API.
 * Three Critical Safety Details for Isolates
 * 1. Native Timing Safety: Node.js requires timingSafeEqual to prevent attackers from guessing the signature by measuring response times. The crypto.subtle.verify method handles this timing-safe comparison inherently at the C++ level.
 * 2. Body Consumption: Middleware that parses the JSON before you verify the signature will alter the byte structure (like removing whitespace) and cause the HMAC to fail. Always grab request.text() first.
 * 3. Hex to ArrayBuffer: The Web Crypto API does not accept Hex strings for verification. The manual Uint8Array loop is required to translate Paddle's h1 string into the raw binary format the V8 isolate expects.
 */

async function verifyPaddleSignature(request, secretKey) {
  const signatureHeader = request.headers.get('paddle-signature');
  if (!signatureHeader) return false;

  // 1. Extract timestamp and signature hash
  const parts = signatureHeader.split(';');
  let ts = '', h1 = '';
  for (const part of parts) {
    if (part.startsWith('ts=')) ts = part.slice(3);
    if (part.startsWith('h1=')) h1 = part.slice(3);
  }

  if (!ts || !h1) return false;

  // 2. Prevent Replay Attacks (Reject if older than 5 minutes)
  const timestampMs = parseInt(ts, 10) * 1000;
  if (Date.now() - timestampMs > 5 * 60 * 1000) {
      console.warn("Webhook timestamp is too old.");
      return false;
  }

  // 3. Reconstruct the signed payload
  // We must use the exact raw body string Paddle sent
  const rawBody = await request.text();
  const payload = `${ts}:${rawBody}`;

  const encoder = new TextEncoder();

  // 4. Import the Paddle Secret Key into Web Crypto
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // 5. Convert Paddle's Hex signature into an ArrayBuffer
  const signatureBytes = new Uint8Array(h1.length / 2);
  for (let i = 0; i < h1.length; i += 2) {
    signatureBytes[i / 2] = parseInt(h1.substring(i, i + 2), 16);
  }

  // 6. Perform a natively timing-safe verification
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(payload)
  );

  // Return both validity and the parsed JSON body for downstream use
  return {
    isValid,
    body: isValid ? JSON.parse(rawBody) : null
  };
}