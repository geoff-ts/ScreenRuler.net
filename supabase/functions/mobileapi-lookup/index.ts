import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const mobileApiKey = Deno.env.get('MOBILEAPI_API_KEY');
const allowedOrigin = Deno.env.get('ALLOWED_ORIGIN') || '';

function corsHeaders(origin: string | null) {
    const permittedOrigin = allowedOrigin || origin || '*';
    return {
        'Access-Control-Allow-Origin': permittedOrigin,
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin'
    };
}

function json(body: unknown, status: number, origin: string | null) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
    });
}

function parseScreenResolution(value: string) {
    const match = value.match(/(\d+(?:\.\d+)?)\s*(?:inches|["”])[^\d]*(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
    if (!match) return null;
    return { diagonal: Number(match[1]), width: Number(match[2]), height: Number(match[3]) };
}

function resolutionMatches(candidate: { width: number; height: number }, width: number, height: number) {
    const direct = Math.abs(candidate.width - width) + Math.abs(candidate.height - height);
    const swapped = Math.abs(candidate.width - height) + Math.abs(candidate.height - width);
    const tolerance = Math.max(width, height) * 0.06;
    return Math.min(direct, swapped) <= tolerance;
}

serve(async (request) => {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
    if (allowedOrigin && origin && origin !== allowedOrigin) return json({ error: 'Origin not allowed' }, 403, origin);
    if (!mobileApiKey) return json({ error: 'MobileAPI is not configured on the server' }, 500, origin);

    try {
        const { model, width, height } = await request.json();
        if (typeof model !== 'string' || model.trim().length < 2 || model.length > 100) {
            return json({ error: 'A valid device model is required' }, 400, origin);
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
            return json({ error: 'A valid screen resolution is required' }, 400, origin);
        }

        const url = new URL('https://api.mobileapi.dev/devices/search/');
        url.searchParams.set('model_number', model.trim());
        url.searchParams.set('exact', 'true');

        const apiResponse = await fetch(url, {
            headers: { 'Authorization': `Token ${mobileApiKey}` }
        });
        if (!apiResponse.ok) return json({ error: 'Device service lookup failed' }, 502, origin);

        const payload = await apiResponse.json();
        const candidates = Array.isArray(payload.devices) ? payload.devices : [];
        const device = candidates.find((candidate: Record<string, unknown>) => {
            if (candidate.match_type !== 'exact_model') return false;
            const screen = typeof candidate.screen_resolution === 'string'
                ? parseScreenResolution(candidate.screen_resolution)
                : null;
            return screen && resolutionMatches(screen, width, height);
        });

        if (!device) return json({ match: null }, 200, origin);
        const screen = parseScreenResolution(device.screen_resolution);
        if (!screen) return json({ match: null }, 200, origin);
        return json({
            match: {
                brand: device.manufacturer_name || device.brand_name || 'Unknown',
                name: device.name,
                diagonal: screen.diagonal,
                width: screen.width,
                height: screen.height,
                confidence: 1
            }
        }, 200, origin);
    } catch {
        return json({ error: 'Invalid lookup request' }, 400, origin);
    }
});
