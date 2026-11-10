# Product Requirements Document: endGO

## 1. Executive Summary

**endGO** is a zero-dependency, Inversion-of-Control (IoC) driven web framework designed to maximize modular composability. Unlike traditional frameworks that tightly couple HTTP verbs to the core application instance (e.g., `app.get()` in Hono), endGO adopts an endpoint-centric philosophy where paths are registered as discrete entities, and handlers remain purely functional. By splitting the execution context into three distinct pillars; the Request, the Requestor, and the Server, endGO guarantees strict isolation of side effects, high testability, and seamless alignment with modern, standards-based web runtimes and microservice issolation patterns.

## 2. Core Architecture & Philosophy

* **Endpoint-Centric Registration:** Endpoints are linked off the object context rather than as methods of the core app, enabling true microservice separation and modular file structures in endGO.
* **Lazy Evaluation:** Payload parsing (JSON, Forms, Multipart) is deferred until explicitly requested by the handler, eliminating unnecessary processing overhead.
* **Native Web Standards:** Relies heavily on native browser APIs (e.g., `Request`, `Response`, `URL`) over monolithic framework abstractions.
* **Tripartite Handler Context:** Every endpoint receives exactly three objects representing the *What* (`request`), the *Who* (`requestor`), and the *Where/How* (`server`).

## 3. System Interfaces & Instantiation in endGO

### Core Initialization

endGO relies on generic dependency injection for its routing and environment engines.

```typescript
const app = new endGO<{ Environment, Router, Resolver }>();

```

* **`Environment`**: (Optional) Key-value object supporting string or structured object values.
* **`Router`**: (Optional) Injection point for `RegExRouter` or `TrieRouter`.
* **`Resolver`**: (Optional) Injection for custom URL path string resolution logic.

### Endpoint Registration

Endpoints are registered using the `.end()` method. To maintain endpoint-first modularity without sacrificing HTTP method specificity, `.end()` accepts either a catch-all handler or a verb-mapped object.

```typescript
// Single handler (Catch-all)
app.end('/api/tasks', taskHandler);

// Verb-mapped handlers
app.end('/api/tasks', {
  GET: getTasks,
  POST: createTask
});

```

## 4. The Tripartite Context Model

The handler signature `handler(request, requestor, server)` acts as the sole entry point for endpoint logic.

### I. The Request Object (The "What")

Wraps the incoming payload. The `resolved` property operates as a Proxy or lazy-evaluator, only invoking parsers when accessed.

| Property | Type | Description |
| --- | --- | --- |
| `request.raw` | `Request` | The raw, native Web API Request object. |
| `request.resolved.url` | `URL` | Native Web API URL object for zero-overhead parsing of path/search. |
| `request.resolved.method` | `string` | The HTTP method (GET, POST, etc.). |
| `request.resolved.protocol` | `string` | The protocol used (e.g., 'http', 'https'). |
| `request.resolved.ip` | `string` | The IP address of the client making the request. |
| `request.resolved.headers` | `Headers` | Parsed incoming HTTP headers. |
| `request.resolved.accepts` | `string[]` | Extracted `Accept` header values for content negotiation. |
| `request.resolved.cookies` | `Record<string, string>` | Parsed cookies from the request. |
| `request.resolved.fresh` | `boolean` | Indicates if the request is fresh based on caching headers. |
| `request.resolved.params` | `Record<string, string>` | URL parameters extracted by the active Router. |
| `request.resolved.query` | `Record<string, string>` | Query parameters parsed from the URL. |
| `request.resolved.body.literal` | `string | null` | The raw text content of a consumed request body. |
| `request.resolved.body.json` | `string | null` | The JSON-parsable string content of the body. |
| `request.resolved.body.object` | `unknown | null` | The parsed instance of `body.json`. |
| `request.resolved.body.form` | `FormData | null` | Parsed standard form data. |
| `request.resolved.body.files` | `File[] | null` | Extracted file streams/buffers from multipart uploads. |
| `request.resolved.body.stream` | `ReadableStream` | For handling large binary inputs without memory buffering. |

### II. The Requestor Object (The "Who")

Maintains the identity, authorization, and localization context of the client invoking the endpoint.

| Property | Type | Description |
| --- | --- | --- |
| `requestor.user` | `object | null` | The authenticated user entity. |
| `requestor.tenant` | `string | null` | The workspace, organization, or tenant ID for the request. |
| `requestor.session` | `object | null` | The active session state associated with the request. |
| `requestor.device` | `object` | Details/fingerprint of the machine/browser making the request. |
| `requestor.roles` | `string[]` | Roles associated with the authenticated user. |
| `requestor.permissions` | `string[]` | Granular permissions granted to the user or token. |
| `requestor.token` | `string | null` | The raw or decoded JWT/auth token. |
| `requestor.authProvider` | `string` | Mechanism of authentication (e.g., 'local', 'oauth', 'api-key'). |
| `requestor.locale` | `string` | The client's language/region preference (e.g., 'en-US'). |
| `requestor.timezone` | `string` | The client's time zone (e.g., 'America/Los_Angeles'). |

### III. The Server Object (The "Where / How")

Acts as the dependency injection container, lifecycle manager, and utility belt for the handler.

| Property | Type | Description |
| --- | --- | --- |
| `server.config` | `object` | Server configuration data. |
| `server.env` | `object` | Environment variables accessible to the server. |
| `server.modules` | `object` | Lazy-loaded modules or external components. |
| `server.services` | `object` | Registered background services or singletons (e.g., DB connections). |
| `server.cache` | `object` | In-memory key-value store interface for rate-limiting or deduping. |
| `server.logger` | `object` | Centralized logging utility. |
| `server.router` | `object` | The internal router instance handling path resolution. |
| `server.endpoints` | `object` | Registry of all currently active endpoints. |
| `server.middleware` | `Function[]` | Pipeline of registered middleware functions. |
| `server.end` | `Function` | Method to register new endpoints dynamically. |
| `server.use` | `Function` | Method to register middleware to the global or routed pipeline. |
| `server.silence` | `Function` | `(endpoint) => void` - Stops listening to a specific endpoint dynamically. |
| `server.listen` | `Function` | `(port, callback) => void` - Binds the server to a network interface. |
| `server.events` | `EventEmitter` | Exposes lifecycle hooks (e.g., `server.on('shutdown', cleanup)`). |
| `server.reply` | `Function` | Standardized response builder injecting CORS and formatting payloads. |

## 5. Middleware and Pipeline Processing

Middleware in endGO should intercept the tripartite context before it reaches the final handler. Because endGO utilizes a `request.resolved` proxy, middleware can read headers or routing parameters without triggering heavy body-parsing prematurely. Authentication middleware will populate the `requestor` object, while logging middleware utilizes `server.logger`.

## 6. Response Protocol

Handlers are designed to remain compatible with standard Web APIs. A handler can resolve a request in two ways:

1. **Native Web API:** `return new Response(data, { status: 200 })`
2. **Server Helper:** `return server.reply(200, data)` to apply global response formatting, automatically serialize JSON, and inject standard framework headers.