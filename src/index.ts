interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * TED MCP — Tenders Electronic Daily (EU public procurement)
 *
 * API docs: https://docs.ted.europa.eu/api/
 * Auth: none. POST only (GET is 405), and `fields` must be non-empty (a 400
 * "Validation error on field fields", which reads like an auth wall but isn't).
 *
 * Tools:
 * - search_notices:       expert-search across all EU procurement notices
 * - get_notice:           fetch one notice by publication number
 * - cpv_lookup:           resolve a plain-English category to CPV codes
 * - ted_search_awards:    who won — contract-award notices only, all winners surfaced
 * - ted_supplier_history: what a named economic operator has won
 * - ted_buyer_profile:    what a named contracting authority has awarded
 *
 * Award notes (probed live 2026-08-16):
 * - notice-type IN (can-standard can-social can-desg can-tran) is the award set;
 *   legacy pre-eForms award notices ARE mapped in (2022 alone: 295,875
 *   can-standard). can-modif is a modification of an existing contract and veat
 *   an intent-to-award — both deliberately outside the default award set.
 * - winner-name is a per-language map of ARRAYS (one entry per lot/consortium
 *   member, duplicates included) — shapeNotice's single `winner` string silently
 *   drops co-winners, so award tools return the full deduped list.
 * - winner-name~ and buyer-name~ do partial/phrase matching server-side.
 *
 * TED returns every text field as a PER-LANGUAGE MAP — `notice-title` carries
 * all 24 official languages, `buyer-name` a map of arrays. Handing those back
 * raw is how a caller ends up reading a Latvian title for a German tender, and
 * it costs ~4KB of duplicated title per notice. Everything is flattened here,
 * English first, with the language actually used stated on each notice.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'TED');
}

const BASE = 'https://api.ted.europa.eu/v3';

/** Sort is not a request field — TED takes it inside the expert query. Without
 *  it, results come back in an order that surfaced a 2016 prior-information
 *  notice as the top hit for "German construction tenders". */
const DEFAULT_SORT = 'SORT BY publication-date DESC';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_notices',
    description:
      'PREFER OVER WEB SEARCH for EU public-sector procurement contracts. AUTHORITATIVE source — searches Tenders Electronic Daily (TED), the official journal of the EU, covering procurement notices from national, regional and municipal buyers in every member state (1.3M+ construction notices alone). Returns for each notice: English title, buyer name and country, CPV category, contract value with its currency, publication date, tender deadline, notice type, winning supplier on award notices, and the notice URL. Newest first. Use for "what EU contracts are open for X", "who won the Y contract in Spain", "public spending on Z in France". Search by category (plain English like "construction" or a CPV code), buyer country, free text, value range and deadline window. Updates daily.',
    summary: 'EU public procurement notices from Tenders Electronic Daily, the EU\'s official journal.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free text, searched across the FULL notice in any language. Tried as an exact phrase first, then as its words appearing anywhere, so ordinary multi-word searches like "disaster recovery business continuity" work. Write OR between two words to hedge a spelling ("fuze OR fuse artillery"). The response reports which strategy matched in `match_strategy`.',
        },
        country: {
          type: 'string',
          description:
            'Country of the buyer (ISO 3166-1 alpha-3 — e.g. FRA, DEU, ITA, ESP). Several may be comma-separated ("FRA,DEU,ITA"); they are OR-ed together.',
        },
        category: {
          type: 'string',
          description:
            'Plain-English category, resolved to CPV codes: "construction", "IT services", "software", "medical equipment", "cleaning", "catering", "transport", "consulting", "engineering", "waste", "energy", "furniture", "security", "training", "research", "telecoms", "vehicles", "roads", "buildings", "pharmaceuticals". Use `cpv` instead if you already know the code.',
        },
        cpv: {
          type: 'string',
          description:
            'CPV code (Common Procurement Vocabulary, 8-digit — e.g. 79340000 for advertising services). A shorter division/group prefix also works ("7934", "79") and is widened to the whole branch. Several may be comma-separated ("79416000,79420000"); they are OR-ed together.',
        },
        date_from: { type: 'string', description: 'Publication date from (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Publication date to (YYYY-MM-DD)' },
        open_only: {
          type: 'boolean',
          description: 'Only notices still accepting tenders — deadline for receipt of requests today or later. Use for "what is open now" questions.',
        },
        value_min: { type: 'number', description: 'Contract value floor (in the notice\'s own currency — most are EUR but not all)' },
        value_max: { type: 'number', description: 'Contract value ceiling (in the notice\'s own currency)' },
        notice_type: {
          type: 'string',
          description:
            'Notice subtype — "cn-standard" (contract notice / call for tenders), "can-standard" (contract award), "pin-only" (prior information). Several may be comma-separated; they are OR-ed together.',
        },
        sort: {
          type: 'string',
          description: 'Ordering: "newest" (default), "oldest", "value_high", "value_low", "deadline_soon".',
        },
        limit: { type: 'number', description: 'Page size, 1-250 (default 25)' },
        page: { type: 'number', description: '1-based page (default 1)' },
      },
    },
  },
  {
    name: 'get_notice',
    description:
      'Fetch a single TED notice by publication number (e.g. "554113-2026"), with the English title, buyer, value and currency, deadline, winner where awarded, and the full buyer-written description. Accepts notice_id / id as aliases.',
    summary: 'One EU public procurement notice in full, by id, from Tenders Electronic Daily.',
    inputSchema: {
      type: 'object',
      properties: {
        publication_number: {
          type: 'string',
          description: 'TED publication number, format "<num>-<year>". notice_id and id are accepted as aliases.',
        },
        notice_id: { type: 'string', description: 'Alias for publication_number.' },
        id: { type: 'string', description: 'Alias for publication_number.' },
      },
      required: ['publication_number'],
    },
  },
  {
    name: 'ted_search_awards',
    description:
      'Who WON EU public contracts — searches contract-AWARD notices in Tenders Electronic Daily (TED), the official journal of the EU (2.8M+ award notices, all member states, back to 2011). Each result names the winning supplier(s), the awarded value with its currency, the buyer and country, CPV category, and award publication date. Use for "who won the X contract in Spain", "recent IT contract awards in France", "awarded construction contracts over 10M EUR". Filter by winner name, buyer name, CPV category (plain English or code), buyer country, winner country, value range, date window. Covers above-threshold EU procurement; values are as published by the buyer, normally excluding VAT.',
    summary: 'EU public procurement contract awards matching a filter, from Tenders Electronic Daily.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free text searched across the full notice in any language (phrase first, then words-anywhere — same escalation as search_notices).',
        },
        winner: { type: 'string', description: 'Winning supplier name, matched partially ("Siemens" finds "Siemens Mobility A/S"). For a full supplier dossier use ted_supplier_history instead.' },
        buyer: { type: 'string', description: 'Contracting authority name, matched partially ("Banedanmark", "Ville de Paris"). For a full buyer dossier use ted_buyer_profile instead.' },
        country: {
          type: 'string',
          description: 'Buyer country (ISO 3166-1 alpha-3 — FRA, DEU, ITA, ESP). Comma-separate several; they are OR-ed.',
        },
        winner_country: { type: 'string', description: 'Winner country (ISO 3166-1 alpha-3). Comma-separate several; they are OR-ed.' },
        category: {
          type: 'string',
          description: 'Plain-English category resolved to CPV codes ("construction", "IT services", "medical equipment" — same vocabulary as search_notices). Use `cpv` if you already know the code.',
        },
        cpv: { type: 'string', description: 'CPV code (8-digit or a shorter prefix, widened to the branch). Comma-separate several; they are OR-ed.' },
        date_from: { type: 'string', description: 'Award publication date from (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Award publication date to (YYYY-MM-DD)' },
        value_min: { type: 'number', description: 'Awarded value floor (in the notice\'s own currency)' },
        value_max: { type: 'number', description: 'Awarded value ceiling (in the notice\'s own currency)' },
        sort: { type: 'string', description: 'Ordering: "newest" (default), "oldest", "value_high", "value_low".' },
        limit: { type: 'number', description: 'Page size, 1-250 (default 25)' },
        page: { type: 'number', description: '1-based page (default 1)' },
      },
    },
  },
  {
    name: 'ted_supplier_history',
    description:
      'Award history of one supplier in EU public procurement — every contract a named economic operator has WON, from TED (Tenders Electronic Daily, the official journal of the EU). Returns the awards newest first (buyer, country, value, currency, category, date) plus a summary: award counts, awarded value by currency, top buyers and top CPV categories. Use for "what has Capgemini won", "who does this supplier sell to", incumbent research before bidding against someone. Name matching is partial — "Siemens" covers every Siemens entity; pass the exact legal name to narrow. Covers above-threshold EU procurement only.',
    summary: 'Every EU public contract a named supplier has won, from Tenders Electronic Daily.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Economic operator (company) name as it appears on notices — matched partially, so the registered local legal form ("Roche Polska Sp. z o.o") and the group name ("Roche") both work.' },
        country: { type: 'string', description: 'Restrict to awards from buyers in this country (ISO 3166-1 alpha-3). Comma-separate several.' },
        category: { type: 'string', description: 'Plain-English category resolved to CPV ("IT services", "pharmaceuticals").' },
        cpv: { type: 'string', description: 'CPV code or prefix. Comma-separate several.' },
        date_from: { type: 'string', description: 'Award publication date from (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Award publication date to (YYYY-MM-DD)' },
        limit: { type: 'number', description: 'Awards to fetch and summarize, 1-250 (default 100, newest first)' },
        page: { type: 'number', description: '1-based page (default 1)' },
      },
      required: ['supplier'],
    },
  },
  {
    name: 'ted_buyer_profile',
    description:
      'Spending profile of one EU public buyer — what a named contracting authority has AWARDED, from TED (Tenders Electronic Daily, the official journal of the EU). Returns the buyer\'s awards newest first (winner, value, currency, category, date) plus a summary: award counts, awarded value by currency, top winning suppliers and top CPV categories. Use for "what does this ministry buy", "who are this city\'s incumbent suppliers", "what does Banedanmark spend on". Name matching is partial. Covers above-threshold EU procurement only — below-threshold national purchases appear on national portals.',
    summary: 'What a named EU public buyer has awarded, from Tenders Electronic Daily.',
    inputSchema: {
      type: 'object',
      properties: {
        buyer: { type: 'string', description: 'Contracting authority name as published — matched partially ("Banedanmark", "Ministerio de Defensa", "Stadt Wien").' },
        country: { type: 'string', description: 'Buyer country (ISO 3166-1 alpha-3), to disambiguate a common name. Comma-separate several.' },
        category: { type: 'string', description: 'Plain-English category resolved to CPV ("construction", "IT services").' },
        cpv: { type: 'string', description: 'CPV code or prefix. Comma-separate several.' },
        date_from: { type: 'string', description: 'Award publication date from (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Award publication date to (YYYY-MM-DD)' },
        limit: { type: 'number', description: 'Awards to fetch and summarize, 1-250 (default 100, newest first)' },
        page: { type: 'number', description: '1-based page (default 1)' },
      },
      required: ['buyer'],
    },
  },
  {
    name: 'cpv_lookup',
    description:
      'Resolve a plain-English procurement category ("construction", "hospital equipment", "IT") to the CPV codes TED indexes it under, or explain what a CPV code covers. Use before search_notices when you know the subject but not the code.',
    summary: 'The EU Common Procurement Vocabulary code(s) matching a keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Plain-English category ("construction") or a CPV code ("45000000", "45").' },
      },
      required: ['term'],
    },
  },
];

/**
 * CPV divisions that actually exist. The vocabulary is not a dense 01-99 range,
 * and TED answers a nonexistent one with `QUERY_UNSUPPORTED_FIELD_VALUE`, which
 * reads as "your search found nothing" rather than "that code isn't a code" —
 * two of those a day in production, e.g. classification-cpv=28000000.
 */
const CPV_DIVISIONS: Record<string, string> = {
  '03': 'agriculture, farming, fishing, forestry',
  '09': 'petroleum, fuels, electricity, energy',
  '14': 'mining, basic metals, related products',
  '15': 'food, beverages, tobacco',
  '16': 'agricultural machinery',
  '18': 'clothing, footwear, luggage',
  '19': 'leather, textiles, plastic, rubber',
  '22': 'printed matter, publications',
  '24': 'chemical products',
  '30': 'office and computing machinery, equipment and supplies',
  '31': 'electrical machinery, apparatus, equipment',
  '32': 'radio, television, communication, telecommunication equipment',
  '33': 'medical equipment, pharmaceuticals, personal care products',
  '34': 'transport equipment and auxiliary products',
  '35': 'security, fire-fighting, police and defence equipment',
  '37': 'musical instruments, sport goods, games, toys, handicraft, art',
  '38': 'laboratory, optical and precision equipment',
  '39': 'furniture, furnishings, domestic appliances, cleaning products',
  '41': 'collected and purified water',
  '42': 'industrial machinery',
  '43': 'machinery for mining, quarrying, construction',
  '44': 'construction structures and materials',
  '45': 'construction work',
  '48': 'software package and information systems',
  '50': 'repair and maintenance services',
  '51': 'installation services',
  '55': 'hotel, restaurant and retail trade services',
  '60': 'transport services (excl. waste transport)',
  '63': 'supporting and auxiliary transport services, travel agency services',
  '64': 'postal and telecommunications services',
  '65': 'public utilities',
  '66': 'financial and insurance services',
  '70': 'real estate services',
  '71': 'architectural, construction, engineering and inspection services',
  '72': 'IT services: consulting, software development, internet and support',
  '73': 'research and development services',
  '75': 'administration, defence and social security services',
  '76': 'services related to the oil and gas industry',
  '77': 'agricultural, forestry, horticultural, aquacultural and apicultural services',
  '79': 'business services: law, marketing, consulting, recruitment, printing and security',
  '80': 'education and training services',
  '85': 'health and social work services',
  '90': 'sewage, refuse, cleaning and environmental services',
  '92': 'recreational, cultural and sporting services',
  '98': 'other community, social and personal services',
};

/**
 * Plain English to CPV. Callers say "construction", not 45000000, and the
 * question they are really asking is usually a whole branch rather than one
 * leaf, so these map to division/group roots that TED widens for us.
 */
const CATEGORY_CPV: { terms: string[]; codes: string[]; label: string }[] = [
  { terms: ['construction', 'building work', 'civil engineering', 'infrastructure'], codes: ['45000000'], label: 'construction work' },
  { terms: ['buildings', 'building construction'], codes: ['45210000'], label: 'building construction work' },
  { terms: ['roads', 'road', 'highway', 'highways'], codes: ['45233000'], label: 'road construction and maintenance' },
  { terms: ['it', 'it services', 'information technology', 'computing'], codes: ['72000000'], label: 'IT services' },
  { terms: ['software', 'software development', 'applications'], codes: ['48000000', '72200000'], label: 'software and software development' },
  { terms: ['cloud', 'hosting', 'data centre', 'data center'], codes: ['72300000', '72410000'], label: 'data and hosting services' },
  { terms: ['telecoms', 'telecom', 'telecommunications', 'networks'], codes: ['32400000', '64200000'], label: 'telecommunications' },
  { terms: ['medical equipment', 'hospital equipment', 'medical devices'], codes: ['33100000'], label: 'medical equipment' },
  { terms: ['pharmaceuticals', 'drugs', 'medicines', 'vaccines'], codes: ['33600000'], label: 'pharmaceutical products' },
  { terms: ['health', 'healthcare', 'health services', 'social care'], codes: ['85000000'], label: 'health and social work services' },
  { terms: ['cleaning', 'janitorial'], codes: ['90910000'], label: 'cleaning services' },
  { terms: ['waste', 'refuse', 'recycling', 'sewage'], codes: ['90500000', '90400000'], label: 'waste and sewage services' },
  { terms: ['catering', 'food', 'canteen'], codes: ['55500000', '15000000'], label: 'catering and food' },
  { terms: ['transport', 'transport services', 'logistics'], codes: ['60000000'], label: 'transport services' },
  { terms: ['vehicles', 'cars', 'buses', 'fleet'], codes: ['34100000', '34120000'], label: 'motor vehicles' },
  { terms: ['rail', 'railway', 'trains'], codes: ['34600000', '45234100'], label: 'railway equipment and works' },
  { terms: ['energy', 'electricity', 'fuel', 'gas'], codes: ['09000000'], label: 'petroleum, fuels and electricity' },
  { terms: ['renewables', 'solar', 'wind power'], codes: ['09330000', '31121340'], label: 'solar and wind energy' },
  { terms: ['consulting', 'consultancy', 'advisory', 'business services'], codes: ['79000000'], label: 'business and consulting services' },
  { terms: ['engineering', 'architecture', 'architectural', 'design services'], codes: ['71000000'], label: 'architectural and engineering services' },
  { terms: ['research', 'r&d', 'research and development'], codes: ['73000000'], label: 'research and development' },
  { terms: ['training', 'education', 'teaching'], codes: ['80000000'], label: 'education and training' },
  { terms: ['security', 'guarding', 'surveillance'], codes: ['79710000', '35000000'], label: 'security services and equipment' },
  { terms: ['furniture', 'office furniture'], codes: ['39100000'], label: 'furniture' },
  { terms: ['legal', 'legal services', 'law'], codes: ['79100000'], label: 'legal services' },
  { terms: ['insurance', 'financial services', 'banking'], codes: ['66000000'], label: 'financial and insurance services' },
  { terms: ['water', 'water supply'], codes: ['41000000', '45232150'], label: 'water supply' },
  { terms: ['defence', 'defense', 'military'], codes: ['35000000'], label: 'security and defence equipment' },
];

/** Sorted, because object key order puts "03"/"09" after "98" — JS orders
 *  integer-like keys first, and a list that ends "…92, 98, 03, 09" reads like a
 *  bug to whoever is being told their code was invalid. */
function divisionList(): string {
  return Object.keys(CPV_DIVISIONS).sort().join(', ');
}

function resolveCategory(term: string): { codes: string[]; label: string } | null {
  const t = term.trim().toLowerCase();
  if (!t) return null;
  for (const row of CATEGORY_CPV) if (row.terms.includes(t)) return { codes: row.codes, label: row.label };
  // Substring match second, longest term first so "medical equipment" beats "it".
  const ranked = CATEGORY_CPV.flatMap((r) => r.terms.map((term2) => ({ term2, r }))).sort((a, b) => b.term2.length - a.term2.length);
  for (const { term2, r } of ranked) if (t.includes(term2)) return { codes: r.codes, label: r.label };
  return null;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_notices':
      return searchNotices(args);
    case 'get_notice': {
      // Aliases: agents commonly reach for notice_id / id when the tool name
      // is "get_notice" — surface the same field under any of those names.
      const pn = (args.publication_number ?? args.notice_id ?? args.id) as string | undefined;
      if (typeof pn !== 'string' || !pn.trim()) {
        throw new Error('Required argument "publication_number" is missing. Pass a TED publication number like "554113-2026" (notice_id and id are accepted as aliases).');
      }
      return getNotice(pn);
    }
    case 'cpv_lookup':
      return cpvLookup(String(args.term ?? ''));
    case 'ted_search_awards':
      return searchAwards(args);
    case 'ted_supplier_history': {
      const supplier = String(args.supplier ?? '').trim();
      if (!supplier) {
        throw new Error('user_error: ted_supplier_history needs `supplier` — the economic operator\'s name as it appears on notices, e.g. "Siemens" or "Roche Polska".');
      }
      return supplierHistory(supplier, args);
    }
    case 'ted_buyer_profile': {
      const buyer = String(args.buyer ?? '').trim();
      if (!buyer) {
        throw new Error('user_error: ted_buyer_profile needs `buyer` — the contracting authority\'s name as published, e.g. "Banedanmark" or "Stadt Wien".');
      }
      return buyerProfile(buyer, args);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function cpvLookup(term: string) {
  const t = term.trim();
  if (!t) {
    throw new Error('user_error: cpv_lookup needs a `term` — a category like "construction" or a CPV code like "45000000".');
  }
  const digits = t.replace(/\D/g, '');
  if (digits) {
    const div = digits.slice(0, 2);
    const covers = CPV_DIVISIONS[div];
    if (!covers) {
      return {
        found: false,
        term,
        reason: 'no_such_cpv_division',
        hint: `CPV division ${div} does not exist — the vocabulary is not a dense 01-99 range. Valid divisions: ${divisionList()}. Pass a plain-English category instead and this tool will pick the code.`,
        divisions: CPV_DIVISIONS,
      };
    }
    return {
      found: true,
      term,
      cpv: normalizeCpv(digits),
      division: div,
      covers,
      note: 'TED matches a code\'s whole branch, so the division root (e.g. 45000000) returns every notice under it.',
    };
  }
  const hit = resolveCategory(t);
  if (!hit) {
    return {
      found: false,
      term,
      reason: 'no_category_match',
      hint: 'No mapping for that phrase. Search free-text instead (search_notices({query})), or pick a CPV division from the list.',
      divisions: CPV_DIVISIONS,
    };
  }
  return { found: true, term, cpv: hit.codes.join(','), covers: hit.label };
}

/**
 * CPV is hierarchical, so a caller who means "advertising services generally"
 * naturally reaches for the division/group prefix — `7934`, or `79`. TED only
 * accepts the full 8-digit form and rejects anything shorter with an opaque
 * `QUERY_UNSUPPORTED_FIELD_VALUE`, which reads as "no such code" rather than
 * "pad it". Zero-padding is not a guess at what they wanted: TED already matches
 * a code's whole branch, so `79340000` returns 50,023 notices and the child
 * `79341100` returns 4,599 of them. `7934` → `79340000` is therefore exactly the
 * search the prefix asked for. Also tolerate a trailing wildcard, which is the
 * other shape models try.
 */
function normalizeCpv(v: string): string {
  const digits = v.replace(/\*+$/, '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 8 ? digits.slice(0, 8) : digits.padEnd(8, '0');
}

/**
 * Build one expert-search term, accepting several values for the fields where
 * asking for several is the natural question ("contracts in France OR Germany").
 *
 * TED rejects a comma-joined value outright — `classification-cpv=A,B` comes
 * back 400 QUERY_UNSUPPORTED_FIELD_VALUE — but comma-separated is exactly what
 * a model reaches for, and we advertised no alternative, so every multi-code
 * search failed. TED's own `IN` form unions them (three CPV codes: 32,009 hits
 * vs 10,369 for one) and survives being AND-ed with the other terms. `IN (x)`
 * behaves identically to `=x`, so a single value could take either path; it
 * takes `=` only to keep the echoed `query` string readable.
 */
function multiTerm(field: string, raw: unknown, transform: (v: string) => string = (v) => v): string {
  if (raw === undefined || raw === null) return '';
  const values = String(raw)
    .split(/[,\s]+/)
    .map((v) => transform(v.trim()))
    .filter(Boolean);
  if (values.length === 0) return '';
  if (values.length === 1) return `${field}=${values[0]}`;
  return `${field} IN (${values.join(' ')})`;
}

/**
 * Free text, and why it is three attempts instead of one.
 *
 * The old shape was `notice-title~"<the whole query>" OR description-proc~"<the
 * whole query>"`, which asks TED for that string as a VERBATIM PHRASE. Nobody
 * writes procurement search terms as a phrase that appears in a notice, so real
 * multi-word searches returned nothing at all — and "nothing" from a tender
 * search reads as "the EU is not buying this", which is a confidently wrong
 * answer rather than a missing one. Measured against the exact queries real
 * callers sent us (from the failure-path arg log):
 *
 *   "backup disaster recovery business continuity"  phrase 0  ·  AND-ed   760
 *   "data center colocation IaaS PaaS"              phrase 0  ·  AND-ed     6
 *   "GRC risk management compliance governance"
 *      + country IN (NLD BEL LUX) + cpv 48000000    phrase 0  ·  AND-ed    27
 *   "trust services"                                phrase 259
 *
 * Two other things that probe settled:
 *  - `FT` searches the WHOLE notice and is what free text should use. The old
 *    title-or-description pair misses a notice whose subject only appears in the
 *    body — `description-proc~"colocation" AND description-proc~"IaaS"` is 0
 *    while the FT equivalent is 6.
 *  - OR-ing every word is far too loose on its own (51,630 hits for the backup
 *    query), so it is the LAST resort and only when the caller has other filters
 *    narrowing the search.
 *
 * Order: phrase (most precise, and right for the short natural phrases people
 * actually type) → all words anywhere → any word anywhere.
 */
const FREE_TEXT_STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'with', 'by', 'from',
  'any', 'all', 'tender', 'tenders', 'contract', 'contracts', 'notice', 'notices',
]);

function freeTextTerms(raw: string): string[] {
  return freeTextClauses(raw).flat();
}

/**
 * Split free text into AND-ed clauses, honouring an OR the caller wrote.
 *
 * A real caller searched `fuze OR fuse artillery ammunition` — they are
 * spelling-hedging a term of art, and AND-ing every word asks TED for a notice
 * containing BOTH spellings, which is exactly the notice that does not exist.
 * `OR` binds its neighbours into one alternation, so that query becomes
 * (fuze OR fuse) AND artillery AND ammunition.
 */
function freeTextClauses(raw: string): string[][] {
  const tokens = raw
    .split(/[^\p{L}\p{N}+#-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  const clauses: string[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^or$/i.test(tok)) {
      // Attach the NEXT token to the clause we just built, rather than starting
      // a new one.
      const next = tokens[i + 1];
      if (next && clauses.length && !FREE_TEXT_STOPWORDS.has(next.toLowerCase())) {
        clauses[clauses.length - 1].push(next);
        seen.add(next.toLowerCase());
        i++;
      }
      continue;
    }
    if (tok.length < 2 || FREE_TEXT_STOPWORDS.has(tok.toLowerCase()) || seen.has(tok.toLowerCase())) continue;
    seen.add(tok.toLowerCase());
    clauses.push([tok]);
  }
  return clauses;
}

function freeTextAttempts(raw: string, hasOtherFilters: boolean): { name: string; term: string }[] {
  if (!raw.trim()) return [{ name: 'none', term: '' }];
  const phrase = `FT~"${escapeQ(raw.trim())}"`;
  const clauses = freeTextClauses(raw);
  const terms = clauses;
  // One clause = one word, or an alternation the caller wrote with OR.
  const clause = (c: string[]) =>
    c.length === 1 ? `FT~"${escapeQ(c[0])}"` : `(${c.map((t) => `FT~"${escapeQ(t)}"`).join(' OR ')})`;
  const and = (cs: string[][]) => `(${cs.map(clause).join(' AND ')})`;
  const attempts = [{ name: 'phrase', term: phrase }];
  if (terms.length > 1) {
    // AND-ing EVERY word over-constrains a long query the same way the phrase
    // does — measured: 5 words AND-ed for "backup disaster recovery business
    // continuity" is 0, the first 3 of them is 760. So relax by dropping
    // trailing words, which works because people write the distinguishing term
    // first ("backup…", "GRC…", "colocation…") and trail off into generic
    // qualifiers. Capped at three upstream calls total; TED is rate-limiting.
    attempts.push({ name: 'all_terms', term: and(terms.slice(0, 3)) });
    if (terms.length > 2) attempts.push({ name: 'core_terms', term: and(terms.slice(0, 2)) });
  }
  // Deliberately NO any-word fallback. It was implemented, measured, and cut:
  // "fuze OR fuse artillery ammunition" returned 42 notices led by *printed
  // matter*, and "digital identity electronic signature electronic seal"
  // returned 3,761 led by a kiosk solution. Both look like answers and are not,
  // which is strictly worse than an honest zero — the same lesson apis-guru's
  // truncate-before-rank bug taught. It also doubles upstream calls against an
  // endpoint that has started 429ing us.
  return attempts;
}

// TED's expert-query grammar has no ASC keyword at all — DESC is the only
// direction modifier it accepts, and ascending is what you get by omitting a
// direction. "SORT BY x ASC" is a QUERY_SYNTAX_ERROR ("extraneous input 'ASC'
// expecting <EOF>"), confirmed directly against the API, not just our client.
const SORTS: Record<string, string> = {
  newest: 'SORT BY publication-date DESC',
  oldest: 'SORT BY publication-date',
  value_high: 'SORT BY total-value DESC',
  value_low: 'SORT BY total-value',
  deadline_soon: 'SORT BY deadline-receipt-request',
};

/** Fields worth asking for. TED needs an explicit non-empty list — omitting it
 *  is a 400, not a default — and every field costs response size, so this is
 *  the set that answers a procurement question and nothing else. */
const SEARCH_FIELDS = [
  'publication-number',
  'notice-title',
  'title-proc',
  'buyer-name',
  'buyer-country',
  'buyer-city',
  'classification-cpv',
  'total-value',
  'total-value-cur',
  'publication-date',
  'deadline-receipt-request',
  'notice-type',
  'winner-name',
  'official-language',
];

const DETAIL_FIELDS = [...SEARCH_FIELDS, 'description-proc', 'place-performance-street-proc'];

/** English if TED has it, otherwise the notice's own language, and always say
 *  which one came back — the whole point is that the caller can tell. */
function pickText(
  field: unknown,
  preferred?: string,
): { text: string | null; language: string | null } {
  if (field == null) return { text: null, language: null };
  if (typeof field === 'string') return { text: field, language: null };
  if (Array.isArray(field)) {
    const first = field.find((v) => typeof v === 'string' && v);
    return { text: (first as string) ?? null, language: null };
  }
  const map = field as Record<string, unknown>;
  const order = ['eng', ...(preferred ? [preferred.toLowerCase()] : []), ...Object.keys(map)];
  for (const lang of order) {
    const v = map[lang];
    const text = Array.isArray(v) ? v.find((x) => typeof x === 'string' && x) : v;
    if (typeof text === 'string' && text) return { text, language: lang };
  }
  return { text: null, language: null };
}

function firstOf(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return (v.find((x) => typeof x === 'string' && x) as string) ?? null;
  return typeof v === 'string' ? v : null;
}

/** TED stamps dates with a UTC offset ("2026-08-11+02:00"). Callers want a day. */
function cleanDate(v: unknown): string | null {
  const s = firstOf(v);
  return s ? s.slice(0, 10) : null;
}

function shapeNotice(raw: Record<string, unknown>, includeDescription = false) {
  const noticeLang = firstOf(raw['official-language'])?.toLowerCase().slice(0, 3);
  const title = pickText(raw['notice-title'], noticeLang);
  const original = pickText(raw['title-proc'], noticeLang);
  const buyer = pickText(raw['buyer-name'], noticeLang);
  const winner = pickText(raw['winner-name'], noticeLang);
  const cpvs = Array.isArray(raw['classification-cpv'])
    ? [...new Set(raw['classification-cpv'] as string[])]
    : [];
  const pn = String(raw['publication-number'] ?? '');

  const shaped: Record<string, unknown> = {
    publication_number: pn,
    title: title.text,
    // Stated, not assumed. A caller who gets a Latvian string should be able to
    // see that it is Latvian without guessing from the alphabet.
    title_language: title.language,
    title_original: original.text && original.text !== title.text ? original.text : undefined,
    buyer: buyer.text,
    buyer_country: firstOf(raw['buyer-country']),
    buyer_city: pickText(raw['buyer-city'], noticeLang).text ?? undefined,
    notice_type: raw['notice-type'] ?? null,
    published: cleanDate(raw['publication-date']),
    deadline: firstOf(raw['deadline-receipt-request']),
    // Value without its currency was being read as EUR. It often isn't: a Czech
    // road-maintenance award came back 3,834,447.9 CZK.
    value: raw['total-value'] ?? undefined,
    currency: firstOf(raw['total-value-cur']) ?? undefined,
    cpv: cpvs.length ? cpvs : undefined,
    winner: winner.text ?? undefined,
    url: pn ? `https://ted.europa.eu/en/notice/${pn}` : undefined,
  };
  if (includeDescription) {
    const desc = pickText(raw['description-proc'], noticeLang);
    shaped.description = desc.text ?? undefined;
    shaped.description_language = desc.language ?? undefined;
  }
  for (const k of Object.keys(shaped)) if (shaped[k] === undefined) delete shaped[k];
  return shaped;
}

interface TedResponse {
  totalNoticeCount?: number;
  notices?: Record<string, unknown>[];
  iterationNextToken?: string;
  timedOut?: boolean;
}

async function tedSearch(query: string, fields: string[], limit: number, page?: number): Promise<TedResponse> {
  const body: Record<string, unknown> = { query, fields, limit, scope: 'ALL' };
  if (page !== undefined) body.page = page;

  // TED began 429ing our shared Cloudflare egress on 2026-08-11 (nginx
  // "429 Too Many Requests", an HTML body). We share one egress IP pool with
  // every other CF tenant, so this is not our call rate alone and it clears in
  // under a second. Two short retries turn a visible failure into a slower
  // answer; beyond that, report it as the throttle it is rather than as a
  // Pipeworx defect.
  let res!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await pwFetch(`${BASE}/notices/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (res.status === 429) {
    throw new Error(
      'upstream_throttled: TED returned 429 Too Many Requests to three attempts. This is a rate limit on shared egress, not a problem with the search — retry in a few seconds.',
    );
  }
  if (!res.ok) {
    const txt = await res.text();
    // TED names the offending value in the body; pass it through rather than
    // reducing it to a status, and mark it as the caller's argument when it is
    // one so it doesn't book as a Pipeworx defect.
    if (res.status === 400 && /UNSUPPORTED_FIELD_VALUE|not supported for search field/i.test(txt)) {
      throw new Error(`user_error: TED rejected a search value — ${txt.slice(0, 300)}`);
    }
    throw new Error(`TED error: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as TedResponse;
}

function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

async function searchNotices(args: Record<string, unknown>) {
  const parts: string[] = [];
  const notes: string[] = [];

  // Free text is resolved against the FULL notice via FT, and only after the
  // caller's own filters are known — see freeTextTerm(), which needs to know
  // whether anything else is constraining the search before it widens.
  const freeText = args.query ? String(args.query) : '';

  const country = multiTerm('buyer-country', args.country, (v) => v.toUpperCase());
  if (country) parts.push(country);

  // Plain-English category resolves to CPV. An explicit `cpv` always wins.
  let cpvRaw = args.cpv;
  if (!cpvRaw && args.category) {
    const hit = resolveCategory(String(args.category));
    if (!hit) {
      throw new Error(
        `user_error: no CPV mapping for category "${args.category}". Call cpv_lookup({term}) to find the code, pass \`cpv\` directly, or use \`query\` for a free-text search.`,
      );
    }
    cpvRaw = hit.codes.join(',');
    notes.push(`category "${args.category}" resolved to CPV ${cpvRaw} (${hit.label})`);
  }
  if (cpvRaw) {
    // Reject a nonexistent division here rather than letting TED answer with an
    // opaque QUERY_UNSUPPORTED_FIELD_VALUE that reads as "found nothing".
    for (const one of String(cpvRaw).split(/[,\s]+/).filter(Boolean)) {
      const div = normalizeCpv(one).slice(0, 2);
      if (div && !CPV_DIVISIONS[div]) {
        throw new Error(
          `user_error: "${one}" is not a valid CPV code — division ${div} does not exist. ` +
            `CPV is not a dense 01-99 range; valid divisions are ${divisionList()}. ` +
            `Call cpv_lookup({term:"..."}) with a plain-English category to get the right code.`,
        );
      }
    }
  }
  const cpv = multiTerm('classification-cpv', cpvRaw, normalizeCpv);
  if (cpv) parts.push(cpv);

  const noticeType = multiTerm('notice-type', args.notice_type);
  if (noticeType) parts.push(noticeType);

  if (args.date_from) parts.push(`publication-date>=${tedDate(String(args.date_from))}`);
  if (args.date_to) parts.push(`publication-date<=${tedDate(String(args.date_to))}`);
  if (args.open_only) {
    parts.push(`deadline-receipt-request>=${today()}`);
    notes.push('open_only: restricted to notices whose deadline for receipt of requests has not passed');
  }
  if (args.value_min !== undefined) parts.push(`total-value>=${args.value_min}`);
  if (args.value_max !== undefined) parts.push(`total-value<=${args.value_max}`);

  const sortKey = String(args.sort ?? 'newest').toLowerCase();
  const sort = SORTS[sortKey] ?? DEFAULT_SORT;
  if (args.sort && !SORTS[sortKey]) notes.push(`unknown sort "${args.sort}" — used newest first`);
  if (sortKey === 'value_high') {
    // Contract values are typed in by the buyer and TED does not validate them.
    // Sorting by value therefore surfaces the typos first: the current top hit
    // for road works is a GBP 1,004,000,000,000 notice for "building
    // materials". Say so, rather than letting a caller quote it.
    notes.push(
      'values are entered by the buyer and TED does not validate them, so the largest are often data-entry errors (missing decimal, minor units) — check `currency` and sanity-check the figure before quoting it',
    );
  }

  const limit = Math.min(250, Math.max(1, (args.limit as number) ?? 25));
  const page = Math.max(1, (args.page as number) ?? 1);

  // Free text is tried in escalating breadth. Each attempt is a real search, so
  // stop at the first that finds anything — see FREE_TEXT_STRATEGIES.
  const attempts = freeTextAttempts(freeText, parts.length > 0);
  let data: TedResponse = {};
  let expertQuery = '';
  let strategy = attempts[0]?.name ?? 'none';
  for (const attempt of attempts) {
    const all = attempt.term ? [...parts, attempt.term] : parts;
    const where = all.length ? all.join(' AND ') : `publication-date>=${tedDateBack(7)}`;
    expertQuery = `${where} ${sort}`;
    strategy = attempt.name;
    data = await tedSearch(expertQuery, SEARCH_FIELDS, limit, page);
    if ((data.notices ?? []).length > 0) break;
  }
  if (freeText && strategy !== 'phrase' && (data.notices ?? []).length > 0) {
    notes.push(
      `no notice contains "${freeText}" as a verbatim phrase, so this matched on its ${strategy === 'all_terms' ? 'first three' : 'two most specific'} words appearing anywhere in the notice`,
    );
  }
  if (freeText && (data.notices ?? []).length === 0) {
    const terms = freeTextTerms(freeText);
    notes.push(
      `no notice contains ${terms.length > 1 ? `all of ${terms.map((t) => `"${t}"`).join(', ')}` : `"${freeText}"`}. ` +
        `This is a real zero, not a broken search — TED was queried for each term across the full notice text. ` +
        `Drop the least specific word, or search the CPV category instead (cpv_lookup({term})).`,
    );
  }

  const shaped = (data.notices ?? []).map((n) => shapeNotice(n));
  return {
    query: expertQuery,
    ...(freeText ? { match_strategy: strategy } : {}),
    total: data.totalNoticeCount ?? null,
    count: shaped.length,
    // A timed-out TED search returns PARTIAL results with a total that no
    // longer matches them. Reporting that as a complete answer is how "there
    // are 12 open contracts" becomes a fact the caller repeats.
    partial: data.timedOut === true,
    ...(data.timedOut === true
      ? { partial_note: 'TED timed out on this search and returned PARTIAL results — the count and total are lower bounds. Narrow the query (add country, category or a date window) and retry.' }
      : {}),
    sorted_by: sortKey in SORTS ? sortKey : 'newest',
    ...(notes.length ? { notes } : {}),
    notices: shaped,
    next_page_token: data.iterationNextToken ?? null,
  };
}

async function getNotice(pubNum: string) {
  // The GET /notices/{id} endpoint now requires an Authorization header (API
  // key) and 400s without one. The public POST /notices/search is keyless, so
  // fetch the single notice by filtering on its publication-number instead —
  // same data, no key. (Was: bare GET → "Missing Authorization header".)
  const clean = pubNum.replace(/[^0-9-]/g, '');
  // TED validates the shape of publication-number itself and answers a
  // malformed one with QUERY_UNSUPPORTED_FIELD_VALUE — an error about our query
  // for what is really "no such notice". Check the format first so the caller
  // gets the format back rather than a 400.
  const malformed = {
    found: false,
    publication_number: pubNum,
    reason: 'no_such_notice',
    hint: `TED has no notice "${pubNum}". The format is "<number>-<year>" with the number as published, e.g. "554113-2026" — not a serial you can construct. Use search_notices to find one.`,
  };
  if (!/^\d{1,8}-\d{4}$/.test(clean)) return malformed;

  let data: TedResponse;
  try {
    data = await tedSearch(`publication-number=${clean}`, DETAIL_FIELDS, 1);
  } catch (e) {
    // TED validates the shape of publication-number itself and answers one it
    // doesn't like with QUERY_UNSUPPORTED_FIELD_VALUE — an error about our
    // query for what is, to the caller, simply no such notice. The regex above
    // can't stand in for TED's own rule (it accepts "1-1900", TED doesn't), so
    // the authority stays with TED and only the SHAPE of the answer changes.
    const msg = e instanceof Error ? e.message : String(e);
    if (/publication-number/.test(msg) && /UNSUPPORTED_FIELD_VALUE/i.test(msg)) return malformed;
    throw e;
  }
  const notice = data.notices?.[0];
  if (!notice) {
    return {
      found: false,
      publication_number: pubNum,
      reason: 'no_such_notice',
      hint: `TED has no notice with publication number "${clean}". The format is "<number>-<year>", e.g. "554113-2026". Use search_notices to find one.`,
    };
  }
  return { found: true, ...shapeNotice(notice, true) };
}

// ---------------------------------------------------------------------------
// Award notices — who won, for how much
// ---------------------------------------------------------------------------

/** The four contract-award notice subtypes. Legacy (pre-eForms) award forms are
 *  mapped into these by TED, so this reaches back to 2011, not just 2024. */
const AWARD_TYPE_TERM = 'notice-type IN (can-standard can-social can-desg can-tran)';

const AWARD_FIELDS = [...SEARCH_FIELDS, 'winner-country', 'winner-decision-date'];

/** Stated on every award response — the two things a caller will otherwise get
 *  wrong: quoting TED as all of European public buying, and reading a value as
 *  VAT-inclusive EUR. */
const AWARD_COVERAGE =
  'TED covers above-threshold EU procurement only — smaller below-threshold contracts are published on national portals and are absent here. Values are as published by the buyer in the notice\'s own currency (see `currency`), normally excluding VAT.';

const AWARD_LANGUAGE_NOTE =
  'Text is served in English where TED provides it, otherwise in the notice\'s original language — each notice states which in title_language / winners_language.';

/** All values of a per-language map field, deduped, English first — the award
 *  tools' replacement for pickText, because winner-name carries EVERY winner
 *  (lots, consortium members) and taking the first silently drops co-winners. */
function pickAllText(field: unknown, preferred?: string): { values: string[]; language: string | null } {
  if (field == null) return { values: [], language: null };
  const dedupe = (arr: unknown[]) => [...new Set(arr.filter((v): v is string => typeof v === 'string' && !!v))];
  if (typeof field === 'string') return { values: [field], language: null };
  if (Array.isArray(field)) return { values: dedupe(field), language: null };
  const map = field as Record<string, unknown>;
  const order = ['eng', ...(preferred ? [preferred.toLowerCase()] : []), ...Object.keys(map)];
  for (const lang of order) {
    const v = map[lang];
    if (v == null) continue;
    const values = dedupe(Array.isArray(v) ? v : [v]);
    if (values.length) return { values, language: lang };
  }
  return { values: [], language: null };
}

function shapeAward(raw: Record<string, unknown>) {
  const noticeLang = firstOf(raw['official-language'])?.toLowerCase().slice(0, 3);
  const shaped = shapeNotice(raw) as Record<string, unknown>;
  delete shaped.winner;
  delete shaped.deadline; // receipt deadlines belong to open notices, not awards
  const winners = pickAllText(raw['winner-name'], noticeLang);
  shaped.winners = winners.values;
  if (winners.language) shaped.winners_language = winners.language;
  const winnerCountries = [...new Set((Array.isArray(raw['winner-country']) ? raw['winner-country'] : []) as string[])];
  if (winnerCountries.length) shaped.winner_countries = winnerCountries;
  const decided = cleanDate(raw['winner-decision-date']);
  if (decided) shaped.decision_date = decided;
  return shaped;
}

/** Filters the three award tools share. Free text is NOT built here — it needs
 *  the escalation loop, which needs to know these parts first. */
function awardParts(args: Record<string, unknown>, notes: string[]): string[] {
  const parts: string[] = [AWARD_TYPE_TERM];

  if (args.winner) parts.push(`winner-name~"${escapeQ(String(args.winner).trim())}"`);
  if (args.buyer) parts.push(`buyer-name~"${escapeQ(String(args.buyer).trim())}"`);

  const country = multiTerm('buyer-country', args.country, (v) => v.toUpperCase());
  if (country) parts.push(country);
  const winnerCountry = multiTerm('winner-country', args.winner_country, (v) => v.toUpperCase());
  if (winnerCountry) parts.push(winnerCountry);

  let cpvRaw = args.cpv;
  if (!cpvRaw && args.category) {
    const hit = resolveCategory(String(args.category));
    if (!hit) {
      throw new Error(
        `user_error: no CPV mapping for category "${args.category}". Call cpv_lookup({term}) to find the code, pass \`cpv\` directly, or use \`query\` for a free-text search.`,
      );
    }
    cpvRaw = hit.codes.join(',');
    notes.push(`category "${args.category}" resolved to CPV ${cpvRaw} (${hit.label})`);
  }
  if (cpvRaw) {
    for (const one of String(cpvRaw).split(/[,\s]+/).filter(Boolean)) {
      const div = normalizeCpv(one).slice(0, 2);
      if (div && !CPV_DIVISIONS[div]) {
        throw new Error(
          `user_error: "${one}" is not a valid CPV code — division ${div} does not exist. Valid divisions: ${divisionList()}. Call cpv_lookup({term:"..."}) with a plain-English category to get the right code.`,
        );
      }
    }
  }
  const cpv = multiTerm('classification-cpv', cpvRaw, normalizeCpv);
  if (cpv) parts.push(cpv);

  if (args.date_from) parts.push(`publication-date>=${tedDate(String(args.date_from))}`);
  if (args.date_to) parts.push(`publication-date<=${tedDate(String(args.date_to))}`);
  if (args.value_min !== undefined) parts.push(`total-value>=${args.value_min}`);
  if (args.value_max !== undefined) parts.push(`total-value<=${args.value_max}`);
  return parts;
}

async function searchAwards(args: Record<string, unknown>) {
  const notes: string[] = [];
  const parts = awardParts(args, notes);
  const freeText = args.query ? String(args.query) : '';

  const sortKey = String(args.sort ?? 'newest').toLowerCase();
  const sort = sortKey in SORTS && sortKey !== 'deadline_soon' ? SORTS[sortKey] : DEFAULT_SORT;
  if (args.sort && (!(sortKey in SORTS) || sortKey === 'deadline_soon')) {
    notes.push(`sort "${args.sort}" does not apply to awards — used newest first`);
  }
  if (sortKey === 'value_high') {
    notes.push(
      'values are entered by the buyer and TED does not validate them, so the largest are often data-entry errors (missing decimal, minor units) — check `currency` and sanity-check the figure before quoting it',
    );
  }

  const limit = Math.min(250, Math.max(1, (args.limit as number) ?? 25));
  const page = Math.max(1, (args.page as number) ?? 1);

  const attempts = freeTextAttempts(freeText, true);
  let data: TedResponse = {};
  let expertQuery = '';
  let strategy = attempts[0]?.name ?? 'none';
  for (const attempt of attempts) {
    const all = attempt.term ? [...parts, attempt.term] : parts;
    expertQuery = `${all.join(' AND ')} ${sort}`;
    strategy = attempt.name;
    data = await tedSearch(expertQuery, AWARD_FIELDS, limit, page);
    if ((data.notices ?? []).length > 0) break;
  }
  if (freeText && strategy !== 'phrase' && (data.notices ?? []).length > 0) {
    notes.push(`no award notice contains "${freeText}" as a verbatim phrase, so this matched on its words appearing anywhere in the notice`);
  }
  const shaped = (data.notices ?? []).map(shapeAward);
  if (shaped.length === 0) {
    notes.push(
      'zero award notices matched. This is a real zero from TED, not a failed search — but it only covers ABOVE-threshold EU procurement; a below-threshold or non-EU contract will never appear. Widen the date window, shorten the name, or drop a filter.',
    );
  }
  return {
    query: expertQuery,
    ...(freeText ? { match_strategy: strategy } : {}),
    total: data.totalNoticeCount ?? null,
    count: shaped.length,
    partial: data.timedOut === true,
    ...(data.timedOut === true
      ? { partial_note: 'TED timed out on this search and returned PARTIAL results — the count and total are lower bounds. Narrow the query and retry.' }
      : {}),
    coverage: AWARD_COVERAGE,
    language_note: AWARD_LANGUAGE_NOTE,
    ...(notes.length ? { notes } : {}),
    awards: shaped,
    next_page_token: data.iterationNextToken ?? null,
  };
}

/** Count/sum rollups over the fetched page of awards. Values are summed BY
 *  CURRENCY — a EUR+PLN+DKK grand total would be a made-up number. */
function summarizeAwards(shaped: Record<string, unknown>[], counterpartyKey: 'buyer' | 'winners') {
  const valueByCurrency: Record<string, { total_awarded: number; awards_with_value: number }> = {};
  const counterparties = new Map<string, number>();
  const divisions = new Map<string, number>();
  let withoutValue = 0;
  for (const a of shaped) {
    const value = typeof a.value === 'number' ? a.value : null;
    const cur = typeof a.currency === 'string' ? a.currency : null;
    if (value !== null && cur) {
      const row = (valueByCurrency[cur] ??= { total_awarded: 0, awards_with_value: 0 });
      row.total_awarded += value;
      row.awards_with_value += 1;
    } else {
      withoutValue += 1;
    }
    const names = counterpartyKey === 'winners' ? ((a.winners as string[]) ?? []) : a.buyer ? [String(a.buyer)] : [];
    for (const n of names) counterparties.set(n, (counterparties.get(n) ?? 0) + 1);
    for (const code of (a.cpv as string[]) ?? []) {
      const div = String(code).slice(0, 2);
      if (CPV_DIVISIONS[div]) divisions.set(div, (divisions.get(div) ?? 0) + 1);
    }
  }
  // Cent-precision sums; summing buyer-entered floats otherwise prints
  // artifacts like 7671315941.059999, which read as our bug.
  for (const row of Object.values(valueByCurrency)) row.total_awarded = Math.round(row.total_awarded * 100) / 100;
  const top = <K>(m: Map<K, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    value_by_currency: valueByCurrency,
    awards_without_published_value: withoutValue,
    [counterpartyKey === 'winners' ? 'top_winners' : 'top_buyers']: top(counterparties, 10).map(([name, awards]) => ({ name, awards })),
    top_categories: top(divisions, 8).map(([div, awards]) => ({ cpv_division: div, covers: CPV_DIVISIONS[div], awards })),
  };
}

async function supplierHistory(supplier: string, args: Record<string, unknown>) {
  const notes: string[] = [];
  const parts = awardParts({ ...args, winner: supplier }, notes);
  const limit = Math.min(250, Math.max(1, (args.limit as number) ?? 100));
  const page = Math.max(1, (args.page as number) ?? 1);
  const data = await tedSearch(`${parts.join(' AND ')} ${DEFAULT_SORT}`, AWARD_FIELDS, limit, page);
  const shaped = (data.notices ?? []).map(shapeAward);
  const total = data.totalNoticeCount ?? shaped.length;
  if (shaped.length === 0) {
    return {
      found: false,
      supplier,
      reason: 'no_awards_on_ted',
      coverage: AWARD_COVERAGE,
      hint: `TED has no contract award naming "${supplier}"${args.country ? ` from buyers in ${args.country}` : ''}${args.category || args.cpv ? ' in that category' : ''}. Matching is partial but literal — try a shorter form of the name, its local registered spelling ("Sp. z o.o", "GmbH", "S.p.A." suffixes count), or drop a filter. A supplier that only wins below-threshold national contracts will never appear here.`,
    };
  }
  return {
    found: true,
    supplier,
    matched_on: `winner-name~"${supplier}" — partial match; every entity whose published name contains it, in any member state`,
    total_awards: total,
    count: shaped.length,
    summary_basis: `summary computed over the ${shaped.length} most recent of ${total} matching awards${total > shaped.length ? ' — raise limit (max 250) or page for the rest' : ''}`,
    summary: summarizeAwards(shaped, 'buyer'),
    coverage: AWARD_COVERAGE,
    language_note: AWARD_LANGUAGE_NOTE,
    ...(notes.length ? { notes } : {}),
    awards: shaped,
    next_page_token: data.iterationNextToken ?? null,
  };
}

async function buyerProfile(buyer: string, args: Record<string, unknown>) {
  const notes: string[] = [];
  const parts = awardParts({ ...args, buyer }, notes);
  const limit = Math.min(250, Math.max(1, (args.limit as number) ?? 100));
  const page = Math.max(1, (args.page as number) ?? 1);
  const data = await tedSearch(`${parts.join(' AND ')} ${DEFAULT_SORT}`, AWARD_FIELDS, limit, page);
  const shaped = (data.notices ?? []).map(shapeAward);
  const total = data.totalNoticeCount ?? shaped.length;
  if (shaped.length === 0) {
    return {
      found: false,
      buyer,
      reason: 'no_awards_on_ted',
      coverage: AWARD_COVERAGE,
      hint: `TED has no contract award from a buyer whose published name contains "${buyer}"${args.country ? ` in ${args.country}` : ''}${args.category || args.cpv ? ' in that category' : ''}. Try the authority's own-language name ("Ville de Paris", not "City of Paris"), a shorter form, or drop a filter. Buyers below the EU thresholds publish nationally and will never appear here.`,
    };
  }
  return {
    found: true,
    buyer,
    matched_on: `buyer-name~"${buyer}" — partial match; every authority whose published name contains it`,
    total_awards: total,
    count: shaped.length,
    summary_basis: `summary computed over the ${shaped.length} most recent of ${total} matching awards${total > shaped.length ? ' — raise limit (max 250) or page for the rest' : ''}`,
    summary: summarizeAwards(shaped, 'winners'),
    coverage: AWARD_COVERAGE,
    language_note: AWARD_LANGUAGE_NOTE,
    ...(notes.length ? { notes } : {}),
    awards: shaped,
    next_page_token: data.iterationNextToken ?? null,
  };
}

function escapeQ(s: string): string {
  return s.replace(/"/g, '\\"');
}

// TED expert search requires YYYYMMDD (compact) or today(N) — not YYYY-MM-DD.
function tedDate(input: string): string {
  return input.replace(/-/g, '').slice(0, 8);
}

function tedDateBack(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
