type ApiError = { ok: false; error: string };
type ApiOk<T> = { ok: true } & T;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", "*");
	headers.set("access-control-allow-methods", "GET,PUT,DELETE,OPTIONS");
	headers.set("access-control-allow-headers", "content-type,x-api-key");
	return new Response(response.body, { status: response.status, headers });
}

function normalizePhone(raw: string): string {
	const digits = raw.replace(/\D/g, "");
	if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
	if (digits.length === 11 && digits.startsWith("7")) return digits;
	return "";
}

function linkKey(phone: string): string {
	return `link:${phone}`;
}

function isAuthorized(request: Request, env: Env): boolean {
	const expected = (env.API_TOKEN || "").trim();
	if (!expected) return true;
	const got = (request.headers.get("x-api-key") || "").trim();
	return Boolean(got) && got === expected;
}

function unauthorized(): Response {
	return withCors(json({ ok: false, error: "unauthorized" } satisfies ApiError, 401));
}

async function handleGet(url: URL, env: Env): Promise<Response> {
	const phoneRaw = url.searchParams.get("phone") || "";
	const phone = normalizePhone(phoneRaw);
	if (!phone) {
		return withCors(json({ ok: false, error: "invalid-phone" } satisfies ApiError, 400));
	}

	const deepLink = await env.MAX_LINKS.get(linkKey(phone));
	return withCors(
		json({
			ok: true,
			phone,
			deepLink: deepLink || "",
			found: Boolean(deepLink),
		} satisfies ApiOk<{ phone: string; deepLink: string; found: boolean }>),
	);
}

async function handlePut(request: Request, env: Env): Promise<Response> {
	let body: { phone?: string; deepLink?: string } | null = null;
	try {
		body = (await request.json()) as { phone?: string; deepLink?: string };
	} catch {
		return withCors(json({ ok: false, error: "invalid-json" } satisfies ApiError, 400));
	}

	const phone = normalizePhone(String(body?.phone || ""));
	const deepLink = String(body?.deepLink || "").trim();

	if (!phone) return withCors(json({ ok: false, error: "invalid-phone" } satisfies ApiError, 400));
	if (!deepLink) return withCors(json({ ok: false, error: "invalid-deeplink" } satisfies ApiError, 400));

	await env.MAX_LINKS.put(linkKey(phone), deepLink);

	return withCors(
		json({
			ok: true,
			phone,
			deepLink,
		} satisfies ApiOk<{ phone: string; deepLink: string }>),
	);
}

async function handleDelete(url: URL, env: Env): Promise<Response> {
	const phone = normalizePhone(url.searchParams.get("phone") || "");
	if (!phone) return withCors(json({ ok: false, error: "invalid-phone" } satisfies ApiError, 400));
	await env.MAX_LINKS.delete(linkKey(phone));
	return withCors(json({ ok: true, phone } satisfies ApiOk<{ phone: string }>));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return withCors(new Response(null, { status: 204 }));
		}

		if (url.pathname === "/health") {
			return withCors(json({ ok: true, service: "max-links-api" }));
		}

		if (!isAuthorized(request, env)) return unauthorized();

		if (url.pathname === "/links" && request.method === "GET") return handleGet(url, env);
		if (url.pathname === "/links" && request.method === "PUT") return handlePut(request, env);
		if (url.pathname === "/links" && request.method === "DELETE") return handleDelete(url, env);

		return withCors(json({ ok: false, error: "not-found" } satisfies ApiError, 404));
	},
} satisfies ExportedHandler<Env>;
